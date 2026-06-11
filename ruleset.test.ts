import { expect, test } from "bun:test"
import { type Permission, type ConfigJson, makeRuleset, resolveRule } from "./ruleset"

type TestRuleResult = [string, string, string, Permission]
function makeRulesetTest(homeDir: string, config: ConfigJson)
: (cwd: string) => (tool: string, ...args: string[]) => TestRuleResult[] {

    const rules = makeRuleset(homeDir, config)
    return cwd => (tool, ...args) => {
        const matches = resolveRule(rules, { homeDir, stripDrive: true }, cwd, { op: tool, args })
        return matches.map(m => [m.path, m.toolRule.pattern, m.pathRule.pattern, m.permission] as TestRuleResult)
    }
}

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
            "node_modules/**": { "*": "allow", "write": "ask", "edit": "deny" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("edit", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "edit", "node_modules/**", "deny"]])
    expect(resolveTest("write", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "write", "node_modules/**", "ask"]])
    expect(resolveTest("read", "node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "*", "node_modules/**", "allow"]])
})

test("check from bottom to top", () => {
    const config: ConfigJson = {
        paths: {
            "*": "ask",
            "./**": { "write": "allow" },
            "node_modules/**": { "edit": "deny" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("read", "/proj/node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "*", "*", "ask"]])
    expect(resolveTest("write", "/proj/node_modules/pkg")).toStrictEqual([["/proj/node_modules/pkg", "write", "./**", "allow"]])
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
            "node_modules/**": { "cp * $1": "deny", "cp $1 *": "allow" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest(
        "cp", "node_modules/pkg", "node_modules/pkgcopy"
    )).toStrictEqual([
        ["/proj/node_modules/pkg", "cp $1 *", "node_modules/**", "allow"],
        ["/proj/node_modules/pkgcopy", "cp * $1", "node_modules/**", "deny"],
    ])
})

test("multiple path rules for single tool call", () => {
    const config: ConfigJson = {
        paths: {
            "*": "ask",
            "node_modules/**": { "cp * $1:!cp $1 *": "deny" },
            "src/**": { "cp $1 *": "allow" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest(
        "cp", "src/index.ts", "node_modules/pkg/index.ts"
    )).toStrictEqual([
        ["/proj/src/index.ts", "cp $1 *", "src/**", "allow"],
        ["/proj/node_modules/pkg/index.ts", "cp * $1:!cp $1 *", "node_modules/**", "deny"],
    ])
})

test("tool patterns always capture", () => {
    const config: ConfigJson = {
        paths: {
            "*": {
                "*": "allow",
                "rm:!rm --dry-run": "deny",
                "mv *:!mv $1 *:!mv * trash": "ask",
            },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("rm", "file")).toStrictEqual([
        ["/proj/file", "rm:!rm --dry-run", "*", "deny"],
    ])
    expect(resolveTest("rm", "--dry-run", "file")).toStrictEqual([
        ["/proj/file", "*", "*", "allow"],
    ])

    expect(resolveTest("mv", "src", "dst")).toStrictEqual([
        ["/proj/dst", "mv *:!mv $1 *:!mv * trash", "*", "ask"],
        ["/proj/src", "*", "*", "allow"],
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

test("read affects different ways to read", () => {
    // todo
})

test("write affects different ways to edit or remove", () => {
    // todo
})

test("edit allows removal", () => {
    // todo
})

test("high-priority & secure", () => {
    // todo
})
