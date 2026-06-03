import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import url from "node:url"

import { type PathMatcher, makeMatcher } from "./pattern-matching"

const permissionRuleShorthands = {
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

type Permission = "deny" | "allow" | "ask"
type PermissionShorthandBase = keyof typeof permissionRuleShorthands
type PermissionShorthand = PermissionShorthandBase | `${PermissionShorthandBase}!`
type ConfigJson = { paths: Record<string, PermissionShorthand | Record<string, Permission> > }

type PermissionRule = { match: (tool: string) => boolean, permission: Permission, pattern: string, }
type TargetRule = {  match: ReturnType<PathMatcher>, permissions: PermissionRule[], pattern: string, }

function resolvePath(opts: { homeDir?: string }, ...paths: string[]): string {
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

function toolMatcher(pattern: string): PermissionRule["match"] {
    // todo
    if (pattern.includes(":!")) {
        const matchers = pattern.split(":!").map(subPattern => toolMatcher(subPattern))
        return target => matchers[0](target) && !matchers.slice(1).some(m => m(target))
    }
    return target => target === pattern || pattern === "*" || pattern === ""
}

export default function (pi: ExtensionAPI) {
    // use same home as for the config
    const homeDir = resolvePath({}, os.homedir())

    const configPath = path.join(getAgentDir(), "extensions", "pi-safeguards.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ConfigJson

    const rules: Record<string, TargetRule[]> = { paths: [] }
    for (const [targetPattern, permissionSpec] of Object.entries(config.paths).reverse()) {

        let expandedPermissionSpec: Record<string, Permission>
        if (typeof permissionSpec === "string" ) {
            const highPriority = permissionSpec.endsWith("!")
            const shorthand = highPriority ? permissionSpec.slice(0, permissionSpec.length - 1) : permissionSpec
            if (!(shorthand in permissionRuleShorthands)) {
                throw new Error(`Unknown shorthand "${shorthand}" for pattern "${targetPattern}"`)
            }
            expandedPermissionSpec = permissionRuleShorthands[shorthand as PermissionShorthandBase]
        } else {
            expandedPermissionSpec = permissionSpec
        }

        const permissions: PermissionRule[] = []
        for (const [actionPattern, permission] of Object.entries(expandedPermissionSpec).reverse()) {
            permissions.push({ match: toolMatcher(actionPattern), permission, pattern: actionPattern })
        }
        rules.paths.push({ match: makeMatcher(targetPattern)(homeDir), permissions, pattern: targetPattern })
    }

	pi.on("tool_call", async (event, ctx) => {
        const input = event.input
        if (!("path" in input) || typeof input.path !== "string") { return }
        const protectedTarget = resolvePath({ homeDir }, ctx.cwd, input.path)
        const targetStat = fs.statSync(protectedTarget, { throwIfNoEntry: false })
        const targetIsDir = targetStat && targetStat.isDirectory()

        const cwd = resolvePath({ homeDir }, ctx.cwd)

        let match: { targetRule: TargetRule, permissionRule: PermissionRule } | undefined = undefined
        for (const rule of rules.paths) {
            if (rule.match(cwd)(protectedTarget, targetIsDir)) {
                for (const tool of rule.permissions) {
                    if (tool.match(event.toolName)) {
                        match = { targetRule: rule, permissionRule: tool }
                        break
                    }
                }
                if (match !== undefined) {
                    break
                }
            }
        }
        if (match === undefined) { return undefined }
        ctx.ui.notify(`[pi-safeguards]\n${event.toolName} ${protectedTarget}\nRule: ${match.targetRule.pattern} -> ${match.permissionRule.pattern} -> ${match.permissionRule.permission}`, "info")

        if (match.permissionRule.permission === "ask") {
            if (!ctx.hasUI) {
                return { block: true, reason: `[pi-safeguards] Requires user approval, but environment is non-interactive` }
            }
            const choice = await ctx.ui.select(`[pi-safeguards]\n\n${event.toolName} ${protectedTarget}\n\nAllow?`, ["Yes", "No"])
            if (choice !== "Yes") {
                return { block: true, reason: `[pi-safeguards] Blocked by user` }
            }
        } else if (match.permissionRule.permission === "deny") {
            return { block: true, reason: `[pi-safeguards] Agent is not supposed to do this` }
        }
		return undefined
	})
}
