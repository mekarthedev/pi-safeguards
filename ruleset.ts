import { type PathMatcher, makePathMatcher } from "./path-matching"
import { type Command, type ToolMatcher, makeToolMatcher } from "./tool-matching"

import path from "node:path"
import url from "node:url"
import fs from "node:fs"

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

type ToolRule = { match: ToolMatcher, permission: Permission, pattern: string, }
type PathRule = { match: ReturnType<PathMatcher>, toolRules: ToolRule[], pattern: string, }
export type Ruleset = Record<string, PathRule[]>

export function makeRuleset(homeDir: string, config: ConfigJson): Ruleset {
    const rules: Ruleset = { paths: [] }
    // todo: numeric-like string keys are interpreted as numeric -> some rules might be out of order
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
            toolRules.push({
                match: makeToolMatcher(toolPattern === "*" ? "*:!cd:!pushd:!popd:!echo:!printf:!basename:!dirname:!realpath" : toolPattern, true),
                permission,
                pattern: toolPattern
            })
        }
        rules.paths.push({ match: makePathMatcher(pathPattern)(homeDir), toolRules, pattern: pathPattern })
    }

    return rules
}

type RuleMatch = {
    path: string,
    isDir: boolean|undefined,
    toolRule: ToolRule,
    pathRule: PathRule,
    permission: Permission,
}
export function resolveRule(
    rules: Ruleset, pathOpts: PathResolutionOpts, cwd: string, command: Command
): RuleMatch[] {
    const ruledPaths = new Set<string>()
    const matches = []
    for (const pathRule of rules.paths) {
        for (const toolRule of pathRule.toolRules) {
            const capturedPaths = toolRule.match(command)
            if (!capturedPaths) continue

            for (const pathRaw of capturedPaths) {
                const targetPath = resolvePath(pathOpts, cwd, pathRaw)
                if (ruledPaths.has(targetPath)) continue

                const stat = fs.statSync(targetPath, { throwIfNoEntry: false })
                const targetIsDir = stat && stat.isDirectory()
                if (pathRule.match(cwd)(targetPath, targetIsDir)) {
                    ruledPaths.add(targetPath)
                    matches.push({
                        path: targetPath,
                        isDir: targetIsDir,
                        toolRule,
                        pathRule,
                        permission: toolRule.permission
                    })
                }
            }
        }
    }
    return matches
}

// Resolves to absolute path ready to be tested against path patterns.
// Similar to node:path.resolve, but:
// - forces "/" as path separator
// - expands ~-home
// - converts from URL form
type PathResolutionOpts = {
    homeDir?: string,
    stripDrive?: boolean,  // for testing
}
export function resolvePath(opts: PathResolutionOpts, ...paths: string[]): string {
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
    const absolutePath = path.resolve(...expanded).split(path.sep).join("/")
    if (opts.stripDrive) {
        const rootSep = absolutePath.indexOf("/")
        return rootSep > 0 ? absolutePath.slice(rootSep) : absolutePath
    }
    return absolutePath
}
