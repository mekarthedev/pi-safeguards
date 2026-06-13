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
    capturedIds: Set<number>
): boolean {
    if (pi >= pattern.length) return true
    if (ai >= args.length) return false
    const argPattern = pattern[pi]
    if (argPattern === "*") {
        let hadMatch = false
        for (let i = ai; i < args.length; i++) {
            if (matchArgs(args, i + 1, pattern, pi + 1, currentCapture, capturedIds)) {
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
                if (matchArgs(args, j + 1, pattern, pi + 1, value, capturedIds)) {
                    if (currentCapture === undefined) {
                        capturedIds.add(ci)
                    }
                    hadMatch = true
                    break
                }
            }
        }
        return hadMatch
    }
    if (args[ai] === argPattern) {
        return matchArgs(args, ai + 1, pattern, pi + 1, currentCapture, capturedIds)
    }
    return false
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
    const matchers: ToolMatcher[] = patternCommands.map(patternCmd => {
        if (patternCmd.op === "*" && patternCmd.args.length === 0) return _ => []

        const pattern = parseArgs(patternCmd, argsReference)

        return command => {
            if (command.op !== pattern.op && pattern.op !== "*") return undefined

            const cmd = parseArgs(command, argsReference)

            let captured = matchOpts(pattern.opts, cmd.opts)
            if (captured === undefined) return undefined

            const capturedIds = new Set<number>()
            if (!matchArgs(cmd.positionals, 0, pattern.positionals, 0, undefined, capturedIds)) return undefined
            const capturedPositionals = capturedIds.values().map(i => cmd.positionals[i]).toArray()
            if (capturedPositionals.length > 0) {
                if (captured.length > 0) {
                    captured = captured.filter(v => capturedPositionals.includes(v))
                    if (captured.length === 0) return undefined
                } else {
                    captured = capturedPositionals
                }
            }

            return captured
        }
    })

    if (matchers.length === 1) return matchers[0]
    return target => {
        let mainMatch = matchers[0](target)
        if (!mainMatch) return undefined
        const capturesRequired = mainMatch.length > 0

        for (const exceptionMatch of matchers.values().drop(1).map(m => m(target))) {
            if (!exceptionMatch) continue
            if (exceptionMatch.length === 0 || !capturesRequired) return undefined
            mainMatch = mainMatch.filter(item => !exceptionMatch.includes(item))
        }
        if (capturesRequired && mainMatch.length === 0) return undefined
        return mainMatch
    }
}
