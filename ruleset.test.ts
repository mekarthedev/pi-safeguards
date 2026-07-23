import { describe, expect, test } from "bun:test"
import { type Permission, type ConfigJson, makeRuleset, resolveRule } from "./ruleset"

type TestRuleResult = [string, string, string, Permission] | [string, string, string, string, Permission]
function makeRulesetTest(homeDir: string, config: ConfigJson)
: (cwd: string) => (tool: string, ...args: string[]) => TestRuleResult[] {

    const rules = makeRuleset(homeDir, config)
    return cwd => (tool, ...args) => {
        const matches = resolveRule(rules, { homeDir, stripDrive: true }, cwd, { op: tool, args })
        return matches.map(m => m.toolRule.origin
            ? [m.path, m.toolRule.origin, m.toolRule.pattern, m.pathRule.pattern, m.permission]
            : [m.path, m.toolRule.pattern, m.pathRule.pattern, m.permission]
        )
    }
}

describe("core", () => {
    test("default rule", () => {
        const resolveDeny = makeRulesetTest("/users/rick", { paths: { "*": "deny" } })("/proj")
        expect(resolveDeny("read", "/any/path")).toStrictEqual([["/any/path", "*", "*", "deny"]])
        expect(resolveDeny("write", "/any/path")).toStrictEqual([["/any/path", "*", "*", "deny"]])
        expect(resolveDeny("edit", "/any/path")).toStrictEqual([["/any/path", "*", "*", "deny"]])

        const resolveAsk = makeRulesetTest("/users/rick", { paths: { "*": "ask" } })("/proj")
        expect(resolveAsk("read", "/any/path")).toStrictEqual([["/any/path", "*", "*", "ask"]])
        expect(resolveAsk("write", "/any/path")).toStrictEqual([["/any/path", "*", "*", "ask"]])
        expect(resolveAsk("edit", "/any/path")).toStrictEqual([["/any/path", "*", "*", "ask"]])
    })

    test("multiple path patterns", () => {
        const config: ConfigJson = {
            paths: {
                "~/**": "ask",
                ".ssh/**": "deny",
                "./**": "allow",
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("write", "/proj/file")).toStrictEqual([["/proj/file", "*", "./**", "allow"]])
        expect(resolveTest("read", "/users/rick/.ssh/id_rsa")).toStrictEqual([["/users/rick/.ssh/id_rsa", "*", ".ssh/**", "deny"]])
        expect(resolveTest("read", "/users/rick/file")).toStrictEqual([["/users/rick/file", "*", "~/**", "ask"]])
        expect(resolveTest("read", "/etc")).toStrictEqual([])
    })

    test("multiple tool patterns", () => {
        const config: ConfigJson = {
            paths: {
                "node_modules/**": { "*": "allow", "delete": "ask", "edit": "deny" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("edit", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "edit", "node_modules/**", "deny"]])
        expect(resolveTest("delete", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "delete", "node_modules/**", "ask"]])
        expect(resolveTest("read", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "*", "node_modules/**", "allow"]])
    })

    test("check from bottom to top", () => {
        const config: ConfigJson = {
            paths: {
                "*": "allow",
                "./**": { "delete": "ask" },
                "node_modules/**": { "edit": "deny" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("read", "/proj/node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "*", "*", "allow"]])
        expect(resolveTest("delete", "/proj/node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "delete", "./**", "ask"]])
        expect(resolveTest("edit", "/proj/node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "edit", "node_modules/**", "deny"]])
    })

    test("multiple paths in a single tool call", () => {
        const config: ConfigJson = {
            paths: {
                "~/.ssh/**": { "cat": "ask" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest(
            "cat", "~/.ssh/github", "~/.ssh/aws", "~/.ssh/mortys-pc"
        )).toStrictEqual([
            ["/users/rick/.ssh/github", "cat", "~/.ssh/**", "ask"],
            ["/users/rick/.ssh/aws", "cat", "~/.ssh/**", "ask"],
            ["/users/rick/.ssh/mortys-pc", "cat", "~/.ssh/**", "ask"],
        ])
    })

    test("multiple tool rules for single tool call", () => {
        const config: ConfigJson = {
            paths: {
                "node_modules/**": { "cp * (*)": "deny", "cp (*)": "allow" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest(
            "cp", "node_modules/pkg", "node_modules/pkgcopy"
        )).toStrictEqual([
            ["/proj/node_modules/pkg", "cp (*)", "node_modules/**", "allow"],
            ["/proj/node_modules/pkgcopy", "cp * (*)", "node_modules/**", "deny"],
        ])
    })

    test("multiple path rules for single tool call", () => {
        const config: ConfigJson = {
            paths: {
                "*": "ask",
                "node_modules/**": { "cp ** (*);": "deny" },
                "src/**": { "cp ** (*) *": "allow" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest(
            "cp", "src/index.ts", "node_modules/pkg/index.ts"
        )).toStrictEqual([
            ["/proj/src/index.ts", "cp ** (*) *", "src/**", "allow"],
            ["/proj/node_modules/pkg/index.ts", "cp ** (*);", "node_modules/**", "deny"],
        ])
    })

    test("captured empty strings are ignored", () => {
        const config: ConfigJson = {
            paths: {
                "*": "deny",
                "~/.ssh/**": { "cat": "ask" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest(
            "cat", "", "~/.ssh/github", "", "~/.ssh/aws", ""
        )).toStrictEqual([
            ["/users/rick/.ssh/github", "cat", "~/.ssh/**", "ask"],
            ["/users/rick/.ssh/aws", "cat", "~/.ssh/**", "ask"],
        ])
        expect(resolveTest(
            "cat", ""
        )).toStrictEqual([])
    })

    test("tool patterns always capture", () => {
        const config: ConfigJson = {
            paths: {
                "*": {
                    "*": "allow",
                    "mv :! mv ** (build/*) * :! mv ** trash;": "ask",
                },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("mv", "src", "build/artefact.zip", "server")).toStrictEqual([
            ["/proj/src", "mv :! mv ** (build/*) * :! mv ** trash;", "*", "ask"],
            ["/proj/server", "mv :! mv ** (build/*) * :! mv ** trash;", "*", "ask"],
            ["/proj/build/artefact.zip", "*", "*", "allow"],
        ])
        expect(resolveTest("mv", "src", "trash")).toStrictEqual([
            ["/proj/src", "*", "*", "allow"],
            ["/proj/trash", "*", "*", "allow"],
        ])
    })

    test("shorthands", () => {
        const config: ConfigJson = {
            paths: {
                "*": "allow",
                "node_modules/a/**": "readonly",
                "node_modules/b/**": "nowrite",
                "/tmp/*": "askwrite",
                "package-lock.json": "noedit",
                "package.json": "askedit",
                "*.log": "writeonly",
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("read", "node_modules/a/pkg")).toStrictEqual([["/proj/node_modules/a/pkg", "*", "*", "allow"]])
        expect(resolveTest("write", "node_modules/a/pkg")).toStrictEqual([["/proj/node_modules/a/pkg", "write", "node_modules/a/**", "deny"]])
        expect(resolveTest("read", "node_modules/b/pkg")).toStrictEqual([["/proj/node_modules/b/pkg", "*", "*", "allow"]])
        expect(resolveTest("write", "node_modules/b/pkg")).toStrictEqual([["/proj/node_modules/b/pkg", "write", "node_modules/b/**", "deny"]])
        expect(resolveTest("read", "/tmp/1372.md")).toStrictEqual([["/tmp/1372.md", "*", "*", "allow"]])
        expect(resolveTest("write", "/tmp/1372.md")).toStrictEqual([["/tmp/1372.md", "write", "/tmp/*", "ask"]])
        expect(resolveTest("edit", "/proj/package-lock.json")).toStrictEqual([["/proj/package-lock.json", "edit", "package-lock.json", "deny"]])
        expect(resolveTest("read", "/proj/package-lock.json")).toStrictEqual([["/proj/package-lock.json", "*", "*", "allow"]])
        expect(resolveTest("edit", "/proj/package.json")).toStrictEqual([["/proj/package.json", "edit", "package.json", "ask"]])
        expect(resolveTest("read", "/proj/package.json")).toStrictEqual([["/proj/package.json", "*", "*", "allow"]])
        expect(resolveTest("read", "/proj/agent.log")).toStrictEqual([["/proj/agent.log", "read", "*.log", "deny"]])
        expect(resolveTest("edit", "/proj/agent.log")).toStrictEqual([["/proj/agent.log", "*", "*", "allow"]])
    })
})

describe("implicit rules", () => {
    test.each<[string, string[], string[], string[], string[]]>([
        ["read f.txt", ["/proj/f.txt"], [], [], []],
        ["edit f.txt", [], ["/proj/f.txt"], [], ["/proj/f.txt"]],
        ["write f.txt", [], ["/proj/f.txt"], [], ["/proj/f.txt"]],
        ["cat a.txt b.txt c.txt", [
            "/proj/a.txt",
            "/proj/b.txt",
            "/proj/c.txt",
        ], [], [], []],
        ["tail f.txt", ["/proj/f.txt"], [], [], []],
        ["head f.txt", ["/proj/f.txt"], [], [], []],
        ["< f.txt", ["/proj/f.txt"], [], [], []],
        ["> f.txt", [], ["/proj/f.txt"], [], ["/proj/f.txt"]],
        [">> f.txt", [], ["/proj/f.txt"], [], ["/proj/f.txt"]],
        ["grep pattern a.txt b.txt c.txt", [
            "/proj/a.txt",
            "/proj/b.txt",
            "/proj/c.txt",
        ], [], [], []],
        ["sed pattern a.txt b.txt c.txt", [
            "/proj/a.txt",
            "/proj/b.txt",
            "/proj/c.txt",
        ], [], [], []],
        ["sed -i pattern a.txt b.txt c.txt", 
            [
                "/proj/a.txt",
                "/proj/b.txt",
                "/proj/c.txt",
            ], [
                "/proj/a.txt",
                "/proj/b.txt",
                "/proj/c.txt",
            ], [], [
                "/proj/a.txt",
                "/proj/b.txt",
                "/proj/c.txt",
            ]
        ],
        ["cp src.txt dst.txt", ["/proj/src.txt"], ["/proj/dst.txt"], [], ["/proj/dst.txt"]],
        ["dd count=42 if=src.txt of=dst.txt", ["/proj/src.txt"], ["/proj/dst.txt"], [], ["/proj/dst.txt"]],
        ["mv src.txt dst.txt",
            ["/proj/src.txt"],
            ["/proj/dst.txt"],
            ["/proj/src.txt"],
            ["/proj/dst.txt", "/proj/src.txt"]
        ],
        ["curl --form file=@i.txt --output o.txt", ["/proj/i.txt"], ["/proj/o.txt"], [], ["/proj/o.txt"]],
        ["curl --data @i.txt --stderr o.txt", ["/proj/i.txt"], ["/proj/o.txt"], [], ["/proj/o.txt"]],
        ["touch f.txt", [], ["/proj/f.txt"], [], ["/proj/f.txt"]],
        ["mkdir d", [], ["/proj/d"], [], ["/proj/d"]],
        ["rm f.txt", [], [], ["/proj/f.txt"], ["/proj/f.txt"]],
        ["unlink f.txt", [], [], ["/proj/f.txt"], ["/proj/f.txt"]],
    ])("%s", (cmd, readPaths, editPaths, deletePaths, writePaths) => {
        const [op, ...args] = cmd.split(" ")
        const pathsToCatchPerTool = {
            "read": readPaths, "edit": editPaths, "delete": deletePaths, "write": writePaths
        }
        for (const [tool, pathsToCatch] of Object.entries(pathsToCatchPerTool)) {
            const resolveTest = makeRulesetTest("/users/rick", {
                paths: { "*": { [tool]: "deny" } }
            })("/proj")
            if (op === tool) {
                expect(resolveTest(op, ...args), tool).toStrictEqual(pathsToCatch.map(path => [
                    path,
                    tool,
                    "*",
                    "deny",
                ]))
            } else {
                expect(resolveTest(op, ...args), tool).toStrictEqual(pathsToCatch.map(path => [
                    path,
                    tool,
                    expect.stringMatching(new RegExp(`^${op}( |$)`)),
                    "*",
                    "deny",
                ]))
            }
        }
    })

    test("overriding", () => {
        const config: ConfigJson = {
            paths: {
                "dist/**": { "write": "ask", "edit": "deny", "truncate": "allow", "unlink": "allow" },
                "src/**": { "write": "ask", "delete": "deny", "truncate": "allow", "unlink": "allow" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")

        expect(resolveTest("truncate", "src/index.ts", "dist/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "truncate", "src/**", "allow"],
            ["/proj/dist/index.ts", "truncate", "dist/**", "allow"],
        ])
        expect(resolveTest("unlink", "src/index.ts", "dist/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "unlink", "src/**", "allow"],
            ["/proj/dist/index.ts", "unlink", "dist/**", "allow"],
        ])
        expect(resolveTest("edit", "dist/index.ts")).toStrictEqual([
            ["/proj/dist/index.ts", "edit", "dist/**", "deny"]
        ])
        expect(resolveTest("edit", "src/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "write", "edit", "src/**", "ask"]
        ])
        expect(resolveTest("mv", "src/index.ts", "dist/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "delete", expect.stringMatching(/^mv( |$)/), "src/**", "deny"],
            ["/proj/dist/index.ts", "edit", expect.stringMatching(/^mv( |$)/), "dist/**", "deny"],
        ])
        expect(resolveTest("write", "dist/index.ts")).toStrictEqual([
            ["/proj/dist/index.ts", "edit", "write", "dist/**", "deny"]
        ])
        expect(resolveTest("write", "src/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "write", "src/**", "ask"]
        ])
        expect(resolveTest("rm", "src/index.ts", "dist/index.ts")).toStrictEqual([
            ["/proj/src/index.ts", "delete", expect.stringMatching(/^rm( |$)/), "src/**", "deny"],
            ["/proj/dist/index.ts", "write", expect.stringMatching(/^rm( |$)/), "dist/**", "ask"],
        ])
    })
})
