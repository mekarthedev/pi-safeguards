import { describe, expect, test } from "bun:test"
import { type Permission, type ConfigJson, makeRuleset, resolveRule } from "./ruleset"

type TestPermission = Permission | `${Permission}!`
type TestRuleResult = [string, string, string, TestPermission] | [string, string, string, string, TestPermission]
function makeRulesetTest(homeDir: string, config: ConfigJson)
: (cwd: string) => (tool: string, ...args: string[]) => TestRuleResult[] {

    const rules = makeRuleset(homeDir, config)
    return cwd => (tool, ...args) => {
        const matches = resolveRule(rules, { homeDir, stripDrive: true }, cwd, { op: tool, args })
        return matches.map(m => {
            const permission: TestPermission = m.highSec ? `${m.permission}!` : m.permission
            return m.toolRule.origin
                ? [m.path, m.toolRule.origin, m.toolRule.pattern, m.pathRule.pattern, permission]
                : [m.path, m.toolRule.pattern, m.pathRule.pattern, permission]
        })
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

describe("high-sec", () => {
    test("high-priority: overrides normal rules regardless of order", () => {
        const config: ConfigJson = {
            paths: {
                "*": "deny",
                "~/.pi/settings.json": { "read": "allow!" },
                "~/.pi/*": "ask",
                "*.json": "ask",

                "*.db": "ask",
                "prod.db": { "*": "deny!", "read": "allow" },
                "test.db": { "*": "allow!", "edit": "deny" },
                "demo.db": { "edit": "deny!", "read": "allow" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("read", "~/.pi/settings.json")).toStrictEqual([
            ["/users/rick/.pi/settings.json", "read", "~/.pi/settings.json", "allow!"]
        ])
        expect(resolveTest("edit", "~/.pi/settings.json")).toStrictEqual([
            ["/users/rick/.pi/settings.json", "*", "*.json", "ask"]
        ])
        expect(resolveTest("read", "~/.pi/auth.json")).toStrictEqual([
            ["/users/rick/.pi/auth.json", "*", "*.json", "ask"]
        ])
        expect(resolveTest("read", "~/.pi/debug.log")).toStrictEqual([
            ["/users/rick/.pi/debug.log", "*", "~/.pi/*", "ask"]
        ])

        expect(resolveTest("read", "prod.db")).toStrictEqual([
            ["/proj/prod.db", "*", "prod.db", "deny!"]
        ])
        expect(resolveTest("edit", "test.db")).toStrictEqual([
            ["/proj/test.db", "*", "test.db", "allow!"]
        ])
        expect(resolveTest("read", "demo.db")).toStrictEqual([
            ["/proj/demo.db", "read", "demo.db", "allow"]
        ])
        expect(resolveTest("edit", "demo.db")).toStrictEqual([
            ["/proj/demo.db", "edit", "demo.db", "deny!"]
        ])
        expect(resolveTest("read", "other.db")).toStrictEqual([
            ["/proj/other.db", "*", "*.db", "ask"]
        ])
    })

    describe("strict: most strict rule wins", () => {
        test("allow vs ask vs deny", () => {
            const config: ConfigJson = {
                paths: {
                    "~/**": { "*": "deny!" },
                    ".ssh/**": { "*": "ask!" },
                    "*.key": { "*": "allow!" },
                }
            }
            const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
            expect(resolveTest("read", "~/.ssh/private.key")).toStrictEqual([
                ["/users/rick/.ssh/private.key", "*", "~/**", "deny!"],
            ])
            expect(resolveTest("read", "~/private.key")).toStrictEqual([
                ["/users/rick/private.key", "*", "~/**", "deny!"],
            ])
            expect(resolveTest("read", "~/.ssh/public.pub")).toStrictEqual([
                ["/users/rick/.ssh/public.pub", "*", "~/**", "deny!"],
            ])
            expect(resolveTest("read", ".ssh/private.key")).toStrictEqual([
                ["/proj/.ssh/private.key", "*", ".ssh/**", "ask!"],
            ])
            expect(resolveTest("read", ".ssh/public.pub")).toStrictEqual([
                ["/proj/.ssh/public.pub", "*", ".ssh/**", "ask!"],
            ])
            expect(resolveTest("read", "private.key")).toStrictEqual([
                ["/proj/private.key", "*", "*.key", "allow!"],
            ])
        })

        test.each<[Permission, Permission]>([
            ["allow", "allow"],
            ["allow", "deny"],
            ["allow", "ask"],
            ["ask", "ask"],
            ["ask", "deny"],
            ["deny", "deny"],
        ])("%s vs %s", (lessStrict, moreStrict) => {
            const config: ConfigJson = {
                paths: {
                    "pa/*": { "read": `${moreStrict}!` },
                    "pa/x": { "read": `${lessStrict}!` },
                    "pb/*": { "read": `${lessStrict}!` },
                    "pb/x": { "read": `${moreStrict}!` },
                    "ta/x": { "*": `${moreStrict}!`, "read": `${lessStrict}!` },
                    "tb/x": { "*": `${lessStrict}!`, "read": `${moreStrict}!` },
                }
            }
            const differentPerm = lessStrict !== moreStrict
            const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
            expect(resolveTest("read", "pa/x")).toStrictEqual([
                ["/proj/pa/x", "read", differentPerm ? "pa/*" : "pa/x", `${moreStrict}!`]
            ])
            expect(resolveTest("read", "pb/x")).toStrictEqual([
                ["/proj/pb/x", "read", "pb/x", `${moreStrict}!`]
            ])
            expect(resolveTest("read", "ta/x")).toStrictEqual([
                ["/proj/ta/x", differentPerm ? "*" : "read", "ta/x", `${moreStrict}!`]
            ])
            expect(resolveTest("read", "tb/x")).toStrictEqual([
                ["/proj/tb/x", "read", "tb/x", `${moreStrict}!`]
            ])
        })
    })

    test("resolved separately per path", () => {
        const config: ConfigJson = {
            paths: {
                "*": "allow",
                "~/.pi/auth.json": { "cat": "deny!" },
                "*.json": "ask",
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("cat", "~/.pi/settings.json", "~/.pi/auth.json", "package.json", "debug.log")).toStrictEqual([
            ["/users/rick/.pi/settings.json", "*", "*.json", "ask"],
            ["/users/rick/.pi/auth.json", "cat", "~/.pi/auth.json", "deny!"],
            ["/proj/package.json", "*", "*.json", "ask"],
            ["/proj/debug.log", "*", "*", "allow"],
        ])
    })

    test("with shorthand syntax", () => {
        const config: ConfigJson = {
            paths: {
                "*": "allow",
                "~/.ssh/*": "writeonly!",
                "~/.pi/*.json": "readonly!",
                "*.json": "ask",
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("write", "~/.pi/auth.json")).toStrictEqual([
            ["/users/rick/.pi/auth.json", "write", "~/.pi/*.json", "deny!"]
        ])
        expect(resolveTest("read", "~/.pi/auth.json")).toStrictEqual([
            ["/users/rick/.pi/auth.json", "*", "*.json", "ask"]
        ])
        expect(resolveTest("read", "~/.ssh/id_rsa")).toStrictEqual([
            ["/users/rick/.ssh/id_rsa", "read", "~/.ssh/*", "deny!"]
        ])
        expect(resolveTest("write", "~/.ssh/id_rsa")).toStrictEqual([
            ["/users/rick/.ssh/id_rsa", "*", "*", "allow"]
        ])
    })

    test("affects implicit rules", () => {
        const config: ConfigJson = {
            paths: {
                "*": "ask",
                "p/*": { "write": "deny!" },
                "p/x": { "edit": "allow" },
                "t/x": { "write": "deny!", "edit": "allow" },
            }
        }
        const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
        expect(resolveTest("edit", "p/x")).toStrictEqual([
            ["/proj/p/x", "write", "edit", "p/*", "deny!"]
        ])
        expect(resolveTest("touch", "p/x")).toStrictEqual([
            ["/proj/p/x", "write", expect.stringMatching(/^touch( |$)/), "p/*", "deny!"]
        ])
        expect(resolveTest("edit", "t/x")).toStrictEqual([
            ["/proj/t/x", "write", "edit", "t/x", "deny!"]
        ])
        expect(resolveTest("touch", "t/x")).toStrictEqual([
            ["/proj/t/x", "write", expect.stringMatching(/^touch( |$)/), "t/x", "deny!"]
        ])
    })
})

test("real world example", async () => {
    const config = await import("./pi-safeguards.example.json", { with: { type: 'json' } }) as ConfigJson
    const resolveIn = makeRulesetTest("/users/rick", config)
    const resolveTest = resolveIn("/users/rick/proj")

    // Security

    expect(resolveTest("cat", "~/.ssh/id_rsa")).toStrictEqual([
        ["/users/rick/.ssh/id_rsa", "*", ".ssh/**:!*.pub", "deny!"]
    ])
    expect(resolveIn("/users/rick/.ssh")("cat", "id_rsa")).toStrictEqual([
        ["/users/rick/.ssh/id_rsa", "*", ".ssh/**:!*.pub", "deny!"]
    ])
    expect(resolveTest("read", "~/.ssh/id_rsa.pub")).toStrictEqual([])
    expect(resolveTest("write", "~/.ssh/id_rsa.pub")).toStrictEqual([
        ["/users/rick/.ssh/id_rsa.pub", "write", ".ssh/**/*.pub", "deny"]
    ])
    expect(resolveTest("cat", "~/.pi/agent/auth.json", "prod.env", "prod.env.example")).toStrictEqual([
        ["/users/rick/.pi/agent/auth.json", "*", ".pi/agent/auth.json", "deny!"],
        ["/users/rick/proj/prod.env", "*", "*.env", "deny"],
        ["/users/rick/proj/prod.env.example", "*", "./**/*", "allow"],
    ])
    expect(resolveTest("read", "~/.pi/agent/extensions/pi-safeguards.json")).toStrictEqual([])
    expect(resolveTest("rm", "~/.pi/agent/extensions/pi-safeguards.json")).toStrictEqual([
        [
            "/users/rick/.pi/agent/extensions/pi-safeguards.json",
            "write", expect.stringMatching(/^rm( |$)/), "pi-safeguards.json", "deny!"
        ],
    ])

    // Overly broad search

    expect(resolveTest("find", "/")).toStrictEqual([
        ["/", "find (*)", "*:!~/**/*", "ask"]
    ])
    expect(resolveTest("find", "/users/rick")).toStrictEqual([
        ["/users/rick", "find (*)", "*:!~/**/*", "ask"]
    ])
    expect(resolveTest("find", "/users/rick/.bun")).toStrictEqual([])
    expect(resolveTest("find", "/users/rick/proj")).toStrictEqual([])
    // #todo: ignore grep pattern (e.g. by implementing "definitions" section):
    // expect(resolveTest("grep", ".ssh/something", "/users/rick/.bun")).toStrictEqual([])
    // expect(resolveTest("grep", "something", "/users/rick/proj")).toStrictEqual([])
    // expect(resolveTest("grep", "something", "/users/rick")).toStrictEqual([
    //     ["/users/rick", "grep *", "*:!~/**/*", "ask"]
    // ])

    // Making changes outside current directory

    expect(resolveTest("read", "/users/rick/.bun/install/global/node_modules/iseven/index.js")).toStrictEqual([])
    expect(resolveTest("write", "/usr/local/bin/node")).toStrictEqual([
        ["/usr/local/bin/node", "write", "*", "ask"]
    ])
    expect(resolveTest("edit", "/etc/passwd")).toStrictEqual([
        ["/etc/passwd", "write", "edit", "*", "ask"]
    ])
    expect(resolveTest("read", "~/.pi/agent/settings.json")).toStrictEqual([])
    expect(resolveTest("edit", "~/.pi/agent/settings.json")).toStrictEqual([
        ["/users/rick/.pi/agent/settings.json", "write", "edit", "*", "ask"]
    ])

    // Inappropriate ways to do something

    expect(resolveTest("rm", "-rf", ".git")).toStrictEqual([
        ["/users/rick/proj/.git", "write", expect.stringMatching(/^rm( |$)/), ".git/**", "deny"]
    ])
    expect(resolveTest("rm", ".git/refs/heads/main")).toStrictEqual([
        [
            "/users/rick/proj/.git/refs/heads/main",
            "write", expect.stringMatching(/^rm( |$)/), ".git/**", "deny"
        ],
    ])
    expect(resolveTest("read", ".git/refs/heads/main")).toStrictEqual([
        ["/users/rick/proj/.git/refs/heads/main", "*", "./**/*", "allow"]
    ])
    expect(resolveTest("edit", ".git/refs/heads/main")).toStrictEqual([
        ["/users/rick/proj/.git/refs/heads/main", "write", "edit", ".git/**", "deny"]
    ])

    expect(resolveTest("read", "node_modules/iseven/dist/index.js")).toStrictEqual([
        ["/users/rick/proj/node_modules/iseven/dist/index.js", "*", "./**/*", "allow"]
    ])
    expect(resolveTest("edit", "node_modules/iseven/dist/index.js")).toStrictEqual([
        [
            "/users/rick/proj/node_modules/iseven/dist/index.js",
            "write", "edit", "node_modules/*/*/**", "deny"
        ]
    ])
    expect(resolveTest("rm", "-rf", "node_modules/iseven/package.json", "node_modules/iseven", "node_modules")).toStrictEqual([
        [
            "/users/rick/proj/node_modules/iseven/package.json",
            "write", expect.stringMatching(/^rm( |$)/), "node_modules/*/*/**", "deny"
        ],
        ["/users/rick/proj/node_modules/iseven", "*", "./**/*", "allow"],
        ["/users/rick/proj/node_modules", "*", "./**/*", "allow"],
    ])
    expect(resolveTest("edit", "package-lock.json")).toStrictEqual([
        ["/users/rick/proj/package-lock.json", "edit", "package-lock.json", "deny"]
    ])
    expect(resolveTest("rm", "package-lock.json")).toStrictEqual([
        ["/users/rick/proj/package-lock.json", "*", "./**/*", "allow"]
    ])
})
