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

type Command = { op: string, args: string[] }

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
