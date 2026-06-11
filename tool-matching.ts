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

export type Command = { op: string, args: string[] }

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
        }
    }
    visit(tree.rootNode)

    return commands
}

type CommandWithOpts = { op: string, opts: Record<string, string>, positionals: string[] }
function parseArgs(cmd: Command): CommandWithOpts {
    const result: CommandWithOpts = {
        op: cmd.op,
        opts: {},
        positionals: [],
    }
    for (const arg of cmd.args) {
        if (arg.startsWith("--")) {
            result.opts[arg.slice(2)] = ""
        } else if (arg !== "-" && arg.startsWith("-")) {
            arg.slice(1).split("").forEach(o => {
                result.opts[o] = ""
            })
        } else {
            result.positionals.push(arg)
        }
    }
    return result
}

function matchArgs(
    args: string[], ai: number,
    pattern: string[], pi: number,
    currentCapture: string|undefined,
    capturedIds: Set<number>
): boolean {
    // console.log("".padStart(pi, " "), "args:", args.slice(0,ai), "pattern:", pattern.slice(pi), "c:", currentCapture, "cd:", capturedIds.size)
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
    if (patternStr.includes(":!")) {
        const matchers = patternStr.split(":!").map(
            (subPattern, i) => makeToolMatcher(subPattern, i === 0 ? forceCapturing : false)
        )
        return target => {
            let mainMatch = matchers[0](target)
            if (!mainMatch) return undefined
            const capturesRequired = mainMatch.length > 0

            for (const exceptionMatch of matchers.values().drop(1).map(m => m(target))) {
                if (!exceptionMatch) continue
                if (exceptionMatch.length === 0 || !capturesRequired) return undefined
                mainMatch = mainMatch.filter(item => !exceptionMatch.includes(item))
            }
            return capturesRequired && mainMatch.length === 0 ? undefined : mainMatch
        }
    }

    if (forceCapturing && !patternStr.includes("$1")) {
        patternStr = patternStr + " $1"
    }

    if (patternStr === "*" || patternStr === "") return _ => []

    const patternCommand = sequenceScript(patternStr)[0]
    if (!patternCommand) return cmd => cmd.op === patternStr && [] || undefined

    const pattern = parseArgs(patternCommand)

    return command => {
        if (command.op !== pattern.op && pattern.op !== "*") return undefined
        
        const cmd = parseArgs(command)

        if (!Object.keys(pattern.opts).every(opt => opt in cmd.opts)) return undefined

        // console.log("positionals:", cmd.positionals, "pattern:", pattern.positionals, "raw:", patternStr)
        const capturedIds = new Set<number>()
        if (matchArgs(cmd.positionals, 0, pattern.positionals, 0, undefined, capturedIds)) {
            // console.log("match")
            return capturedIds.values().map(i => cmd.positionals[i]).toArray()
        }
        return undefined
    }
}
