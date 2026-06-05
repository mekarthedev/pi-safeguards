import { loadConfig } from "./config-loading"
import { makeRuleset, resolvePath, resolveRule } from "./ruleset"

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export default function (pi: ExtensionAPI) {
    const configPath = path.join(getAgentDir(), "extensions", "pi-safeguards.json")
    const config = loadConfig(configPath)
    if (!config) { return }

    // use same home as for the config
    const homeDir = resolvePath({}, os.homedir())
    const rules = makeRuleset(homeDir, config)

	pi.on("tool_call", async (event, ctx) => {
        const input = event.input
        if (!("path" in input) || typeof input.path !== "string") { return }
        const protectedTarget = resolvePath({ homeDir }, ctx.cwd, input.path)
        const targetStat = fs.statSync(protectedTarget, { throwIfNoEntry: false })
        const targetIsDir = targetStat && targetStat.isDirectory()

        const cwd = resolvePath({ homeDir }, ctx.cwd)

        const matchedRule = resolveRule(rules, cwd, protectedTarget, targetIsDir, event.toolName)
        if (matchedRule === undefined) { return undefined }
        ctx.ui.notify(`[pi-safeguards]\n${event.toolName} ${protectedTarget}\nrule: ${matchedRule.pathRule.pattern} -> ${matchedRule.toolRule.pattern} -> ${matchedRule.permission}`, "info")

        if (matchedRule.permission === "ask") {
            if (!ctx.hasUI) {
                return { block: true, reason: `[pi-safeguards] Requires user approval, but environment is non-interactive` }
            }
            const choice = await ctx.ui.select(`[pi-safeguards]\n\n${event.toolName} ${protectedTarget}\n\nAllow?`, ["Yes", "No"])
            if (choice !== "Yes") {
                return { block: true, reason: `[pi-safeguards] Blocked by user` }
            }
        } else if (matchedRule.permission === "deny") {
            return { block: true, reason: `[pi-safeguards] Agent is not supposed to do this` }
        }
		return undefined
	})
}
