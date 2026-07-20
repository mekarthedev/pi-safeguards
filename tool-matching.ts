import { Parser, Language, type Node } from "web-tree-sitter"
import url from "node:url"

// Why web-tree-sitter instead of tree-sitter?
// Because tree-sitter's Node bindings are compiled during install,
// which requires things like Visual Studio on the end user machine.
await Parser.init()
const Bash = await Language.load(url.fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm")))
const parser = new Parser()
parser.setLanguage(Bash)

/*
function printTree(tree: any) {
    function visit(node: Node, out: any = {}) {
        out.grammarType = node.grammarType
        out.type = node.type
        out.text = node.text
        out.children = []
        for (const [i, child] of node.children.entries()) {
            const ch: any = {}
            ch.fieldName = node.fieldNameForChild(i)
            out.children.push(ch)
            visit(child, ch)
        }
        return out
    }

    console.dir(visit(tree.rootNode), { depth: null })
}
*/

export type Command = { op: string, args: string[], comment?: string }

// Parses script into flat sequence of operations in order of execution (mostly).
// Redirects to/from files are categorized as either ">", ">>", or "<". Heredocs are ignored.
// Entering and exiting subshell is indicated as "(" and ")".
export function sequenceScript(script: string): Command[] {
    function textContent(node: Node): string {
        const isRaw = node.type === "raw_string"
        const text = isRaw || node.type === "string"
            ? node.text.slice(1, node.text.length-1)
            : node.text
        return isRaw ? text : text.replace(/\\(.)/g, '$1')
    }

    const tree = parser.parse(script)
    if (!tree) { return [] }
    // printTree(tree)

    const commands: Command[] = []
    function visit(node: Node) {
        const isSubshell = (
            node.type === "command_substitution"
            || node.type === "process_substitution"
            || node.type === "subshell"
        )
        const isPipeline = node.type === "pipeline"

        if (isSubshell || isPipeline) {
            commands.push({ op: "(", args: [] })
        }
        for (const child of node.children) {
            if (isPipeline && (child.type === "|" || child.type === "|&")) {
                commands.push({ op: ")", args: [] }, { op: "(", args: [] })
            }
            const isBackground = child.nextSibling?.type === "&"
            if (isBackground) { commands.push({ op: "(", args: [] }) }
            visit(child)
            if (isBackground) { commands.push({ op: ")", args: [] }) }
        }
        if (isSubshell || isPipeline) {
            commands.push({ op: ")", args: [] })
        }

        if (node.type === "command") {
            const cmd = node.childForFieldName("name")?.firstChild
            const args = node.childrenForFieldName("argument")
            commands.push({
                op: cmd && textContent(cmd) || `unknown-cmd(${node.text})`,
                args: args.map(n => textContent(n)),
            })

        } else if (node.type === "file_redirect") {
            const type = node.children.find(n => ["<", ">", ">>", "&>", "&>>", ">|"].includes(n.type))
            const destination = node.childForFieldName("destination")
            if (!type || !destination) return
            commands.push({
                op: type.text.match(/<|>>?/)?.[0] || "",
                args: [textContent(destination)]
            })

        } else if (node.type === "comment") {
            if (commands.length > 0) {
                commands[commands.length - 1].comment = node.text
            }
        }
    }
    visit(tree.rootNode)

    return commands
}

type ExecutionSimulation = {
    parentShells: any[],
    dirStack: string[][],
    oldPwd: string[] | undefined,
    cwd: string[] | undefined,
    onNext(cmd: Command): ExecutionSimulation,
}
export function executionSimulation(initialCwd: string, homeDir: string|undefined): ExecutionSimulation {
    return {
        parentShells: [],
        dirStack: [],
        oldPwd: undefined,
        cwd: [initialCwd],
        onNext(cmd) {
            if (this.cwd === undefined) return this

            switch (cmd.op) {
            case "cd":
                const oldPwd = this.oldPwd
                this.oldPwd = this.cwd
                const arg = cmd.args.find(arg => arg !== "-L" && arg !== "-P")
                if (arg === undefined) {
                    this.cwd = homeDir !== undefined ? [homeDir] : undefined
                } else if (arg === "-") {
                    this.cwd = oldPwd
                } else {
                    this.cwd = [...this.cwd, arg]
                }
                break
            case "pushd":
                this.dirStack = [...this.dirStack, this.cwd]
                this.oldPwd = this.cwd
                this.cwd = [...this.cwd, cmd.args[0]]
                break
            case "popd":
                this.oldPwd = this.cwd
                this.cwd = this.dirStack.at(-1)
                if (this.cwd !== undefined) {
                    this.dirStack = this.dirStack.slice(0, -1)
                }
                break
            case "(":
                this.parentShells.push([this.dirStack, this.oldPwd, this.cwd])
                break
            case ")":
                [this.dirStack, this.oldPwd, this.cwd] = this.parentShells.pop() || [["???"]]
                break
            } 
            return this
        }
    }
}

type CommandOpt<Value = string> = {
    values: Value[],
    expectsValue: boolean|undefined,
    provided: boolean,
} & (
    {
        longName: string,
        shortName: string|undefined,
    } | {
        longName: string|undefined,
        shortName: string,
    }
)
type CommandWithOpts<Value = string> = { op: Value, opts: Record<string, CommandOpt<Value>>, positionals: Value[] }
const longOptionRegex = /^(?<name>--[^=]+)(=(?<value>.*))?$/
// possible hints: [-n=], [--name=], [-n|--name], [-n|--name=], [--name|-n], [--name|-n=]
const optionHintRegex = /\[((?<short>-[^-])(\|(?<long>--[^=\]]+))?|(?<long>--[^=\]]+)(\|(?<short>-[^-=]))?)(?<hasValue>=)?\]/g
function parseArgs<V = string>(cmd: Command, reference?: CommandWithOpts, parseValue?: (raw: string) => V): CommandWithOpts<V> {
    if (!parseValue) {
        parseValue = raw => raw as unknown as V
    }
    const result: CommandWithOpts<V> = {
        op: parseValue(cmd.op),
        opts: {},
        positionals: [],
    }

    if (reference) {
        for (const ref of Object.values(reference.opts)) {
            const opt = {
                ...ref,
                values: [],
                provided: false
            }
            if (ref.longName) { result.opts[ref.longName] = opt }
            if (ref.shortName) { result.opts[ref.shortName] = opt }
        }
    }
    if (cmd.comment) {
        for (const hintMatch of cmd.comment.matchAll(optionHintRegex)) {
            if (!hintMatch.groups) throw "impossible"
            const longName = hintMatch.groups.long
            const shortName = hintMatch.groups.short
            const expectsValue = hintMatch.groups?.hasValue !== undefined
            const opt = {
                values: [],
                longName,
                shortName,
                expectsValue,
                provided: false
            }
            if (longName) { result.opts[longName] = opt }
            if (shortName) { result.opts[shortName] = opt }
        }
    }

    // Assume options with both short and long opt name reference the same opt object
    for (let argIndex = 0; argIndex < cmd.args.length; argIndex++) {
        const arg = cmd.args[argIndex]
        if (arg === "--") {
            result.positionals.push(...cmd.args.slice(argIndex + 1).map(a => parseValue(a)))
            break
        }

        const longOption = longOptionRegex.exec(arg)
        if (longOption) {
            const longName = longOption.groups?.name || arg
            const opt = result.opts[longName] || {
                values: [],
                longName,
                shortName: undefined,
                expectsValue: undefined,
                provided: true
            } satisfies CommandOpt
            result.opts[longName] = opt
            if (!opt.provided) {
                opt.values = []
                opt.provided = true
            }

            let value = longOption.groups?.value
            if (value === undefined && opt.expectsValue && !cmd.args[argIndex + 1]?.startsWith("-")) {
                value = cmd.args[argIndex + 1]
                argIndex += 1
            }
            if (value !== undefined) {
                opt.values.push(parseValue(value))
                opt.expectsValue = true
            }
            continue
        }

        if (arg !== "-" && arg.startsWith("-")) {
            for (const [i, letter] of arg.split("").entries().drop(1)) {
                const shortName = "-" + letter
                const opt = result.opts[shortName] || {
                    values: [],
                    longName: undefined,
                    shortName,
                    expectsValue: undefined,
                    provided: true
                } satisfies CommandOpt
                result.opts[shortName] = opt

                if (!opt.provided) {
                    opt.values = []
                    opt.provided = true
                }

                let value = arg[i + 1] === "=" ? arg.slice(i + 2) : undefined
                if (value === undefined && opt.expectsValue) {
                    if (i + 1 < arg.length) {
                        value = arg.slice(i + 1)
                    } else if (!cmd.args[argIndex + 1]?.startsWith("-")) {
                        value = cmd.args[argIndex + 1]
                        argIndex += 1
                    }
                }
                if (value !== undefined) {
                    opt.values.push(parseValue(value))
                    opt.expectsValue = true
                    break
                }
            }
            continue
        }

        result.positionals.push(parseValue(arg))
    }
    return result
}

type ValueMatcherContext = {
    totalCGroups: number
    cgroupIdxs: Record<string, number>  // capture group name to capture group index
    backrefs: Record<string, string>  // backref group name to capture group name
    newValueMatcher(pattern: string): ValueMatcher
}
type ValueMatcher = { pattern: string|RegExp, context: ValueMatcherContext }

const captureGroupRegex = /\(([^)]*)\)/
function newMatchingContext(): ValueMatcherContext {
    const context: ValueMatcherContext = {
        totalCGroups: 0,
        cgroupIdxs: {},
        backrefs: { "br": "c1" },
        newValueMatcher(pattern: string): ValueMatcher {
            if (pattern === "**") return { pattern, context }
            if (!pattern.includes("*") && !pattern.includes("$1")) return { pattern, context }
    
            let hadBackref = false
            function glob2regex(part: string) {
                return part.split(/(\*|\$1)/).map(p => {
                    switch (p) {
                        case "*": return ".*"
                        case "$1": {  // #todo: support $2, $3, etc
                            if (hadBackref) return "\\k<br>"
                            hadBackref = true
                            return "(?<br>.*)"
                        }
                        default: return RegExp.escape(p)
                    }
                }).join("")
            }
            const parts = pattern.split(captureGroupRegex).map((part, i) =>
                i % 2 === 1 ? `(?<${nextCGroupName()}>` + glob2regex(part) + ")" : glob2regex(part)
            )
            return { pattern: new RegExp("^" + parts.join("") + "$"), context }
        }
    }
    function nextCGroupName(): string {
        const name = "c" + (++context.totalCGroups)
        context.cgroupIdxs[name] = context.totalCGroups
        return name
    }
    return context
}

type CaptureSet = {
    captures?: Map<string, Set<string>>
    backrefs?: Map<string, Set<string>>
    rawBackrefs?: Map<string, Set<string>>
}

function addCaptures(captureSet: CaptureSet, newCaptures: Record<string, string>, context: ValueMatcherContext) {
    for (const [group, value] of Object.entries(newCaptures)) {
        let map: Map<string, Set<string>>
        if (context.backrefs[group]) {
            if (!captureSet.rawBackrefs) { captureSet.rawBackrefs = new Map() }
            map = captureSet.rawBackrefs
        } else {
            if (!captureSet.captures) { captureSet.captures = new Map() }
            map = captureSet.captures
        }
        map.getOrInsertComputed(group, () => new Set()).add(value)
    }
}

function reconcileBackrefs(captureSet: CaptureSet) {
    if (!captureSet.rawBackrefs) return
    if (!captureSet.backrefs) {
        captureSet.backrefs = captureSet.rawBackrefs
    } else {
        for (const [brGroup, values] of captureSet.rawBackrefs) {
            captureSet.backrefs.set(brGroup, values)
        }
    }
    captureSet.rawBackrefs = undefined
}

// During value matching only backrefs are filtered out.
// Captured values also need to be filtered out.
// All backrefs must reference something.
// I.e. something must have been captured by referenced group. And no group will become empty.
function cleanupReferencedGroups(captureSet: CaptureSet, context: ValueMatcherContext) {
    if (!captureSet.backrefs) return
    if (!captureSet.captures) throw "Bug: there are backreferences while no capture groups"
    for (const [backrefGroup, refs] of captureSet.backrefs) {
        const captureGroup = context.backrefs[backrefGroup]
        const captures = captureSet.captures.get(captureGroup)
        if (!captures) throw `Bug: ${backrefGroup} backreferences group that didn't capture`
        const inCommon = captures.intersection(refs)
        if (inCommon.size === 0) throw `Bug: ${backrefGroup} backreferences a value that wasn't captured`
        captureSet.captures.set(captureGroup, inCommon)
    }
}

function matchValue(
    value: string,
    matcher: ValueMatcher,
    captureCandidates: Record<string, string>,
    captureSet: CaptureSet
): undefined | [Record<string, string>|undefined, Record<string, string>] {
    if (typeof matcher.pattern === "string") return matcher.pattern === value ? [undefined, captureCandidates] : undefined

    const match = matcher.pattern.exec(value)
    if (!match) return undefined
    if (match.length === 1) return [undefined, captureCandidates]

    if (match.groups) {
        for (const [group, refValue] of Object.entries(match.groups)) {
            const cgroup = matcher.context.backrefs[group]
            if (!cgroup) continue

            const newCapture = match.groups[cgroup]
            if (newCapture !== undefined) {
                if (refValue !== newCapture) return undefined
                else continue
            }
            const candidateBackref = captureCandidates[group]
            if (candidateBackref !== undefined) {
                if (refValue !== candidateBackref) return undefined
                else continue
            }
            const candidateCapture = captureCandidates[cgroup]
            if (candidateCapture !== undefined) {
                if (refValue !== candidateCapture) return undefined
                else continue
            }
            const otherBackrefs = captureSet.backrefs?.get(group)
            if (otherBackrefs !== undefined) {
                if (!otherBackrefs.has(refValue)) return undefined
                else continue
            }
            const otherCaptures = captureSet.captures?.get(cgroup)
            if (otherCaptures !== undefined) {
                if (!otherCaptures.has(refValue)) return undefined
                else continue
            }
            // Backreferences must reference something captured.
            return undefined
        }
    }

    return [match.groups, { ...captureCandidates, ...match.groups }]
}

function matchOrdered(
    args: string[], ai: number,
    pattern: ValueMatcher[], pi: number,
    captureCandidates: Record<string, string>,
    captureSet: CaptureSet
): boolean {
    if (pi >= pattern.length) return true
    const matcher = pattern[pi]

    if (matcher.pattern === ";" && pi === pattern.length - 1) {
        return ai >= args.length
    }

    if (matcher.pattern === "**") {
        let hadMatch = false
        let i = ai
        do {
            if (matchOrdered(args, i, pattern, pi + 1, captureCandidates, captureSet)) {
                hadMatch = true
            }
        } while (i++ < args.length)
        return hadMatch
    }

    if (ai >= args.length) return false

    const valueMatch = matchValue(args[ai], matcher, captureCandidates, captureSet)
    if (!valueMatch) return false
    const [newCaptures, newCandidates] = valueMatch

    if (!matchOrdered(
        args, ai + 1,
        pattern, pi + 1,
        newCandidates,
        captureSet
    )) return false

    if (newCaptures) {
        addCaptures(captureSet, newCaptures, matcher.context)
    }
    return true
}

function matchPositionals(
    positionals: string[], pattern: ValueMatcher[], captureSet: CaptureSet
): boolean {
    if (!matchOrdered(positionals, 0, pattern, 0, {}, captureSet)) return false
    reconcileBackrefs(captureSet)
    return true
}

function matchUnordered(values: string[], patterns: ValueMatcher[], captureSet: CaptureSet): boolean {
    if (values.length < patterns.length) return false
    const usedValues = new Array(values.length).fill(false)

    function matchRest(pi: number, captureCandidates: Record<string, string>): boolean {
        if (pi >= patterns.length) return true

        const matcher = patterns[pi]

        // #todo: Kuhn's algo?
        let hadMatch = false
        for (let vi = 0; vi < values.length; vi++) {
            if (usedValues[vi]) continue
            const value = values[vi]

            const valueMatch = matchValue(value, matcher, captureCandidates, captureSet)
            if (!valueMatch) continue
            const [newCaptures, newCandidates] = valueMatch
            usedValues[vi] = true

            if (!matchRest(pi + 1, newCandidates)) {
                usedValues[vi] = false
                continue
            }
            usedValues[vi] = false
            hadMatch = true

            if (newCaptures) {
                addCaptures(captureSet, newCaptures, matcher.context)
            }
        }
        return hadMatch
    }

    if (!matchRest(0, {})) return false
    reconcileBackrefs(captureSet)
    return true
}

function matchOpts(
    cmd: Record<string, CommandOpt>,
    pattern: Record<string, CommandOpt<ValueMatcher>>,
    captureSet: CaptureSet
): boolean {
    for (const patternOpt of Object.values(pattern)) {
        if (!patternOpt.provided) continue

        const cmdOpt = cmd[patternOpt.longName || patternOpt.shortName || ""]
        if (!cmdOpt || !cmdOpt.provided) return false

        const match = matchUnordered(cmdOpt.values, patternOpt.values, captureSet)
        if (!match) return false
    }
    return true
}

function matchArgs(
    cmd: CommandWithOpts,
    pattern: CommandWithOpts<ValueMatcher>,
    context: ValueMatcherContext
): Set<string> | undefined {

    const captureSet: CaptureSet = {}
    if (!matchOpts(cmd.opts, pattern.opts, captureSet)) return undefined
    if (!matchPositionals(cmd.positionals, pattern.positionals, captureSet)) return undefined

    cleanupReferencedGroups(captureSet, context)

    const result = new Set<string>()
    if (!captureSet.captures) return result

    const ordered = new Array<Set<string>>(captureSet.captures.size)
    for (const [group, captures] of captureSet.captures) {
        const index = context.cgroupIdxs[group]
        ordered[index - 1] = captures
    }
    for (const captures of ordered) {
        for (const c of captures) result.add(c)
    }
    return result
}

export type ToolMatcher = (cmd: Command) => undefined|string[]

/*
Roadmap:
- separate opts from positionals:
    - parsing target command args depends on how pattern was parsed
    - everything starting with "-" is option (except "--")
    - target command arg: "-k/--key value" -> did pattern contain "-k=" or "--key="?
        - no -> parse arg as option "-k/--key" and positional "value"
        - yes -> parse as option with value
    - support opts definition hints in pattern: "sort # [-o|--output=]"
    - everything after "--" is positional
- for positional args order matters, for opts -> doesn't
    - unordered positionals: "dd [--]of=*", "tar [-]cvf"
- wildcard
    - "*" on its own = exactly one positional arg
    - "something*" = zero or more characters (--something*, --something=*, --some*=*)
    - "**" - special positional, matches 0 or more positionals
    - ";" - like "$" in regex
- capturing
    - "dd of=(*)" or "dd of=(/secrets/*)"
    - union all captures if multiple capture groups in single pattern
    - backreference with "$1"
        - between opts
        - between positionals
        - between opts and positionals
        - within single arg
- ":!"-exceptions have two modes of operation:
    - without capturing in main pattern -> `main() && !exceptions.some()`
    - with capturing -> subtract exception's captures from main captures, or fail on exception without captures
*/
export function makeToolMatcher(patternStr: string, forceCapturing = false): ToolMatcher {
    const patternCommands = []
    for (const [i, subStr] of patternStr.split(":!").entries()) {
        let cmd: Command|undefined = sequenceScript(subStr.replace(/([();])/g, '\\$1'))[0]
        if (!cmd) {
            if (i > 0) continue
            cmd = { op: "*", args: [] }
        }
        if (cmd.args.length === 0) {
            if (cmd.op.length > 1 && cmd.op.endsWith(";")) {
                cmd.op = cmd.op.slice(0, cmd.op.length - 1)
                cmd.args.push(";")
            }
        } else {
            const lastArg = cmd.args[cmd.args.length - 1]
            if (lastArg.length > 1 && lastArg.endsWith(";")) {
                cmd.args[cmd.args.length - 1] = lastArg.slice(0, lastArg.length - 1)
                cmd.args.push(";")
            }
        }
        patternCommands.push(cmd)
    }
    if (forceCapturing) {
        const mainArgs = patternCommands[0].args
        if (mainArgs.at(-1) !== ";" && !mainArgs.some(arg => arg.match(captureGroupRegex))) {
            if (!mainArgs.includes("--")) {
                mainArgs.push("--")
            }
            mainArgs.push("**", "(*)")
        }
    }

    let argsReference = patternCommands.reduce(  // assuming all subpatterns match the same op
        (reference, patternCmd) => parseArgs(patternCmd, reference),
        undefined as CommandWithOpts|undefined
    )
    // todo: if (patternCmd.op === "*" && patternCmd.args.length === 0) return _ => []
    let patterns = patternCommands.map(pattern => {
        const context = newMatchingContext()
        return [parseArgs(pattern, argsReference, context.newValueMatcher), context] as const
    })
    const [main, mainContext] = patterns[0]
    return command => {
        if (!matchValue(command.op, main.op, {}, {})) return undefined

        // #todo: somehow parse command args only once
        const cmd = parseArgs(command, argsReference)
        const match = matchArgs(cmd, main, mainContext)
        if (!match) return undefined

        // Rules:
        // - if exception match with no captures -> result is "doesn't match"
        // - if main had no captures -> same as if all captures where excluded, or as if exception had no captures
        // - otherwise -> exclude exception's captures from main
        for (const [exception, exceptionContext] of patterns.values().drop(1)) {
            if (!matchValue(cmd.op, exception.op, {}, {})) continue

            const exceptionMatch = matchArgs(cmd, exception, exceptionContext)
            if (!exceptionMatch) continue
            if (exceptionMatch.size === 0) return undefined

            for (const e of exceptionMatch) { match.delete(e) }
            if (match.size === 0) return undefined
        }

        return Array.from(match)
    }
}
