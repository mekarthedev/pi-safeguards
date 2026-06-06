import { type PathMatcher, makeMatcher } from "./path-matching"

import path from "node:path"
import url from "node:url"

const permissionShorthands = {
    "deny": { "*": "deny" },
    "allow": { "*": "allow" },
    "ask": { "*": "ask" },
    "readonly": { "write": "deny" },
    "nowrite": { "write": "deny" },
    "askwrite": { "write": "ask" },
    "writeonly": { "read": "deny" },
    "noedit": { "edit": "deny" },
    "askedit": { "edit": "ask" },
} as const

export type Permission = "deny" | "allow" | "ask"
type PermissionShorthandBase = keyof typeof permissionShorthands
type PermissionShorthand = PermissionShorthandBase | `${PermissionShorthandBase}!`
export type ConfigJson = { paths: Record<string, PermissionShorthand | Record<string, Permission> > }

type ToolRule = { match: (tool: string) => boolean, permission: Permission, pattern: string, }
type PathRule = { match: ReturnType<PathMatcher>, toolRules: ToolRule[], pattern: string, }
export type Ruleset = Record<string, PathRule[]>

function makeToolMatcher(pattern: string): ToolRule["match"] {
    // todo
    if (pattern.includes(":!")) {
        const matchers = pattern.split(":!").map(subPattern => makeToolMatcher(subPattern))
        return target => matchers[0](target) && !matchers.slice(1).some(m => m(target))
    }
    return target => target === pattern || pattern === "*" || pattern === ""
}

export function makeRuleset(homeDir: string, config: ConfigJson): Ruleset {
    const rules: Ruleset = { paths: [] }
    for (const [pathPattern, toolConfig] of Object.entries(config.paths).reverse()) {

        let expandedToolConfig: Record<string, Permission>
        if (typeof toolConfig === "string" ) {
            const highPriority = toolConfig.endsWith("!")
            const shorthand = highPriority ? toolConfig.slice(0, toolConfig.length - 1) : toolConfig
            if (!(shorthand in permissionShorthands)) {
                throw new Error(`Unknown shorthand "${shorthand}" for pattern "${pathPattern}"`)
            }
            expandedToolConfig = permissionShorthands[shorthand as PermissionShorthandBase]
        } else {
            expandedToolConfig = toolConfig
        }

        const toolRules: ToolRule[] = []
        for (const [toolPattern, permission] of Object.entries(expandedToolConfig).reverse()) {
            toolRules.push({ match: makeToolMatcher(toolPattern), permission, pattern: toolPattern })
        }
        rules.paths.push({ match: makeMatcher(pathPattern)(homeDir), toolRules, pattern: pathPattern })
    }

    return rules
}

type RuleMatch = { pathRule: PathRule, toolRule: ToolRule, permission: Permission }
export function resolveRule(rules: Ruleset, cwd: string, path: string, isDir: boolean|undefined, tool: string): RuleMatch|undefined {
    for (const pathRule of rules.paths) {
        if (pathRule.match(cwd)(path, isDir)) {
            for (const toolRule of pathRule.toolRules) {
                if (toolRule.match(tool)) {
                    return { pathRule, toolRule, permission: toolRule.permission }
                }
            }
        }
    }
    return undefined
}

// Resolves to absolute path ready to be tested against path patterns.
// Similar to node:path.resolve, but:
// - forces "/" as path separator
// - expands ~-home
// - converts from URL form
export function resolvePath(opts: { homeDir?: string }, ...paths: string[]): string {
    const expanded = paths.map(p => {
        if (opts.homeDir) {
            if (p === "~") { return opts.homeDir }
            if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
                return path.resolve(opts.homeDir, p.slice(2))
            }
        }
        if (p.startsWith("file://")) {
            return url.fileURLToPath(p)
        }
        return p
    })
    return path.resolve(...expanded).split(path.sep).join("/")
}
