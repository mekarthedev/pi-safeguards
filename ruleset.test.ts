import { expect, test } from "bun:test"
import { type Permission, type ConfigJson, makeRuleset, resolveRule } from "./ruleset"

function resolveRuleTest(...args: Parameters<typeof resolveRule>): [string, string, Permission] | undefined {
    const match = resolveRule(...args)
    if (!match) { return undefined }
    return [match.pathRule.pattern, match.toolRule.pattern, match.permission]
}

function makeRulesetTest(...args: Parameters<typeof makeRuleset>)
: (cwd: string) => (path: string, tool: string) => ReturnType<typeof resolveRuleTest> {
    const rules = makeRuleset(...args)
    return cwd => (path, tool) => resolveRuleTest(rules, cwd, path, undefined, tool)
}

test("default", () => {
    const denyAll = makeRuleset("/h", { paths: { "*": "deny" } })
    expect(resolveRuleTest(denyAll, "/p", "/any/path", undefined, "read")) .toStrictEqual(["*", "*", "deny"])
    const askAll = makeRuleset("/h", { paths: { "*": "ask" } })
    expect(resolveRuleTest(askAll, "/p", "/any/path", undefined, "read")) .toStrictEqual(["*", "*", "ask"])
})

test("multiple paths", () => {
    const config: ConfigJson = {
        paths: {
            "~/**": "ask",
            ".ssh/**": "deny",
            "./**": "allow",
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("/proj/file", "write")).toStrictEqual(["./**", "*", "allow"])
    expect(resolveTest("/users/rick/.ssh/id_rsa", "read")).toStrictEqual([".ssh/**", "*", "deny"])
    expect(resolveTest("/users/rick/file", "read")).toStrictEqual(["~/**", "*", "ask"])
    expect(resolveTest("/etc", "read")).toStrictEqual(undefined)
})

test("multiple tools", () => {
    const config: ConfigJson = {
        paths: {
            "node_modules/**": { "*": "allow", "write": "ask", "edit": "deny" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("node_modules/pkg", "edit")).toStrictEqual(["node_modules/**", "edit", "deny"])
    expect(resolveTest("node_modules/pkg", "write")).toStrictEqual(["node_modules/**", "write", "ask"])
    expect(resolveTest("node_modules/pkg", "read")).toStrictEqual(["node_modules/**", "*", "allow"])
})

test("tools don't match -> check next path", () => {
    const config: ConfigJson = {
        paths: {
            "*": "ask",
            "./**": { "write": "allow" },
            "node_modules/**": { "edit": "deny" },
        }
    }
    const resolveTest = makeRulesetTest("/users/rick", config)("/proj")
    expect(resolveTest("/proj/node_modules/pkg", "read")).toStrictEqual(["*", "*", "ask"])
    expect(resolveTest("/proj/node_modules/pkg", "write")).toStrictEqual(["./**", "write", "allow"])
    expect(resolveTest("/proj/node_modules/pkg", "edit")).toStrictEqual(["node_modules/**", "edit", "deny"])
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
    expect(resolveTest("node_modules/a/pkg", "read")).toStrictEqual(["*", "*", "allow"])
    expect(resolveTest("node_modules/a/pkg", "write")).toStrictEqual(["node_modules/a/**", "write", "deny"])
    expect(resolveTest("node_modules/b/pkg", "read")).toStrictEqual(["*", "*", "allow"])
    expect(resolveTest("node_modules/b/pkg", "write")).toStrictEqual(["node_modules/b/**", "write", "deny"])
    expect(resolveTest("/tmp/1372.md", "read")).toStrictEqual(["*", "*", "allow"])
    expect(resolveTest("/tmp/1372.md", "write")).toStrictEqual(["/tmp/*", "write", "ask"])
    expect(resolveTest("/proj/package-lock.json", "edit")).toStrictEqual(["package-lock.json", "edit", "deny"])
    expect(resolveTest("/proj/package-lock.json", "read")).toStrictEqual(["*", "*", "allow"])
    expect(resolveTest("/proj/package.json", "edit")).toStrictEqual(["package.json", "edit", "ask"])
    expect(resolveTest("/proj/package.json", "read")).toStrictEqual(["*", "*", "allow"])
    expect(resolveTest("/proj/agent.log", "read")).toStrictEqual(["*.log", "read", "deny"])
    expect(resolveTest("/proj/agent.log", "edit")).toStrictEqual(["*", "*", "allow"])
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
