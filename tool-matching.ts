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
export function sequenceScript(script: string): Command[] {
    function textContent(node: Node): string {
        if (node.type === "raw_string" || node.type === "string") {
            return node.text.slice(1, node.text.length-1)
        }
        return node.text
    }

    const tree = parser.parse(script)
    if (!tree) { return [] }
    // printTree(tree)

    const commands: Command[] = []
    function visit(node: Node) {
        for (const child of node.children) {
            visit(child)
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

type CommandOpt = {
    values: string[],
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
type CommandWithOpts = { op: string, opts: Record<string, CommandOpt>, positionals: string[] }
const longOptionRegex = /^(?<name>--[^=]+)(=(?<value>.*))?$/
// possible hints: [-n=], [--name=], [-n|--name], [-n|--name=], [--name|-n], [--name|-n=]
const optionHintRegex = /\[((?<short>-[^-])(\|(?<long>--[^=\]]+))?|(?<long>--[^=\]]+)(\|(?<short>-[^-=]))?)(?<hasValue>=)?\]/g
function parseArgs(cmd: Command, reference?: CommandWithOpts): CommandWithOpts {
    const result: CommandWithOpts = {
        op: cmd.op,
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
            result.positionals.push(...cmd.args.slice(argIndex + 1))
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
            } as CommandOpt
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
                opt.values.push(value)
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
                } as CommandOpt
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
                    opt.values.push(value)
                    opt.expectsValue = true
                    break
                }
            }
            continue
        }

        result.positionals.push(arg)
    }
    return result
}

function matchArgs(
    args: string[], ai: number,
    pattern: string[], pi: number,
    currentCapture: string|undefined,
    capturedIdxs: Set<number>
): boolean {
    if (pi >= pattern.length) return true
    if (ai >= args.length) return false
    const argPattern = pattern[pi]
    if (argPattern === "*") {
        let hadMatch = false
        for (let i = ai; i < args.length; i++) {
            if (matchArgs(args, i + 1, pattern, pi + 1, currentCapture, capturedIdxs)) {
                hadMatch = true
            }
        }
        return hadMatch
    }
    if (argPattern === "$1") {
        let hadMatch = false
        for (let ci = ai; ci < args.length; ci++) {
            let value = args[ci]
            if (currentCapture !== undefined && value !== currentCapture) continue

            for (let j = ci; j < args.length; j++) {
                if (matchArgs(args, j + 1, pattern, pi + 1, value, capturedIdxs)) {
                    if (currentCapture === undefined) {
                        capturedIdxs.add(ci)
                    }
                    hadMatch = true
                    break
                }
            }
        }
        return hadMatch
    }
    if (args[ai] === argPattern) {
        return matchArgs(args, ai + 1, pattern, pi + 1, currentCapture, capturedIdxs)
    }
    return false
}

function matchPositionals(positionals: string[], pattern: string[]): number[] | undefined {
    const capturedIdxs = new Set<number>()
    if (!matchArgs(positionals, 0, pattern, 0, undefined, capturedIdxs)) return undefined
    return Array.from(capturedIdxs)
}

function matchOpts(pattern: Record<string, CommandOpt>, cmd: Record<string, CommandOpt>): string[]|undefined {
    let captured: string[] = []
    for (const patternOpt of Object.values(pattern)) {
        if (!patternOpt.provided) continue

        const cmdOpt = cmd[patternOpt.longName || patternOpt.shortName || ""]
        if (!cmdOpt || !cmdOpt.provided) return undefined

        if (cmdOpt.values.length < patternOpt.values.length) return undefined

        let hasCapture = false
        const consumableValues: (string|undefined)[] = [...cmdOpt.values]
        for (const p of patternOpt.values) {
            if (p === "*") continue
            if (p === "$1") {
                hasCapture = true
            } else {
                const i = consumableValues.indexOf(p)
                if (i < 0) return undefined
                consumableValues[i] = undefined
            }
        }
        if (hasCapture) {
            if (captured.length === 0) {
                captured = consumableValues.filter(v => v !== undefined)
            } else {
                captured = captured.filter(v => consumableValues.includes(v))
            }
            if (captured.length === 0) return undefined
        }
    }
    return captured
}

function matchCommand(
    cmd: CommandWithOpts, pattern: CommandWithOpts
): Map<string, number[]> | undefined {

    if (cmd.op !== pattern.op && pattern.op !== "*") return undefined

    let optsMatch = matchOpts(pattern.opts, cmd.opts)
    if (!optsMatch) return undefined

    let posMatch = matchPositionals(cmd.positionals, pattern.positionals)
    if (!posMatch) return undefined

    // Rules:
    // - if either one didn't capture then result is the other one's captures
    // - if both had captures then result is only values captured by both
    // - if there were some captures then result also must have captures
    const match = new Map<string, number[]>()
    if (posMatch.length > 0) {
        const onlyInCommon = optsMatch.length > 0
        for (const idx of posMatch) {
            const value = cmd.positionals[idx]
            const inOpts = optsMatch.indexOf(value) >= 0
            if (!inOpts && onlyInCommon) continue
            match.getOrInsert(value, []).push(idx)
        }
        if (onlyInCommon && match.size === 0) return undefined

    } else {
        for (const value of optsMatch) {
            match.set(value, [])
        }
    }
    return match
}

export type ToolMatcher = (cmd: Command) => undefined|string[]

/*
- separate opts from positionals:
    - parsing target command args depends on how pattern was parsed
    - everything starting with "-" is option
    - target command arg: "-k/--key value" -> did pattern contain "-k=" or "--key="?
        - no -> parse arg as option "-k/--key" and positional "value"
        - yes -> parse as option with value
    - support opts definition hints in pattern: "sort [-o|--output=]"
- for positional args order matters, for opts -> doesn't
    - unordered positionals: "dd [--]of=$1", "tar [-]cvf"
- wildcard
    - "*" on its own = exactly one positional arg
    - "something*" = zero or more characters (--something*, --something=*, --some*=*)
- wildcarded positionals ("*" or "some*") allow zero or more positionals before and after them
- non-wildcarded positionals always together: "git status" doesn't match "git branch status"
- ":!"-exceptions have two modes of operation:
    - without $1 in main pattern -> `main() && !exceptions.some()`
    - with $1 -> subtract exception $1-captures from main $1-captures, or fail on exception without $1
*/
export function makeToolMatcher(patternStr: string, forceCapturing = false): ToolMatcher {
    const patternCommands = []
    for (const [i, subStr] of patternStr.split(":!").entries()) {
        let cmd: Command|undefined = sequenceScript(subStr)[0]
        if (!cmd) {
            if (i > 0) continue
            cmd = { op: "*", args: [] }
        }
        patternCommands.push(cmd)
    }
    if (forceCapturing && !patternCommands[0].args.some(arg => arg.includes("$1"))) {
        if (!patternCommands[0].args.includes("--")) {
            patternCommands[0].args.push("--")
        }
        patternCommands[0].args.push("$1")
    }

    let argsReference = patternCommands.reduce(  // assuming all subpatterns match the same op
        (reference, patternCmd) => parseArgs(patternCmd, reference),
        undefined as CommandWithOpts|undefined
    )
    // todo: if (patternCmd.op === "*" && patternCmd.args.length === 0) return _ => []
    let patterns = patternCommands.map(pattern => parseArgs(pattern, argsReference))
    return command => {
        const cmd = parseArgs(command, argsReference)
        const match = matchCommand(cmd, patterns[0])
        if (!match) return undefined

        // Rules:
        // - (1) if exception match with no captures -> result is "doesn't match"
        // - (2) if main had no captures -> same as if all captures where excluded, or as if exception had no captures
        // - otherwise -> exclude exception's captures from main
        //   - (3) if exception captured positionals -> exclude from positionals captured by main (by pos index)
        //   - (4) otherwise -> exclude captured value (by value)
        //     - (5) if main didn't capture positionals -> same as if all where excluded
        //     - note: in `cmd --opt=$1 $1` it is easier to interpret opt as just additional filter for captured positionals
        for (const exception of patterns.values().drop(1)) {
            const exceptionMatch = matchCommand(cmd, exception)
            if (!exceptionMatch) continue
            if (exceptionMatch.size === 0) return undefined  // (1)

            for (const [value, exceptPositions] of exceptionMatch) {
                if (exceptPositions.length === 0) {  // (4)
                    match.delete(value)
                    continue
                }
                let positions = match.get(value)
                if (!positions) continue
                positions = positions.filter(i => !exceptPositions.includes(i))  // (3)
                if (positions.length > 0) {
                    match.set(value, positions)
                } else {
                    match.delete(value)
                }
            }

            if (match.size === 0) return undefined  // (2)(5)
        }

        return Array.from(match.keys())
    }
}
