import { loadConfig } from "./config-loading"
import { makeRuleset, resolvePath, resolveRule } from "./ruleset"
import { sequenceScript } from "./tool-matching"

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
        const actions = [
            ...("path" in input && typeof input.path === "string" ? [{ op: event.toolName, args: [input.path] }] : []),
            ...("command" in input && typeof input.command === "string" ? sequenceScript(input.command) : [])
        ]

        const cwd = resolvePath({ homeDir }, ctx.cwd)
        const ruledActions = []
        for (const action of actions) {
            for (const arg of action.args) {
                const targetPath = resolvePath({ homeDir }, ctx.cwd, arg)
                const targetStat = fs.statSync(targetPath, { throwIfNoEntry: false })
                const targetIsDir = targetStat && targetStat.isDirectory()
                const rule = resolveRule(rules, cwd, targetPath, targetIsDir, action.op)
                if (rule !== undefined) {
                    ruledActions.push({ op: action.op, arg, rule})
                }
            }
        }

        ctx.ui.notify(
            "[pi-safeguards]\n" + ruledActions
                .map(action => `${action.op} ${action.arg}\n${action.rule.pathRule.pattern} -> ${action.rule.toolRule.pattern} -> ${action.rule.permission}`)
                .join("\n"),
            "info"
        )

        const deniedAction = ruledActions.find(action =>
            action.rule.permission === "deny" || !ctx.hasUI && action.rule.permission === "ask"
        )
        if (deniedAction) {
            if (deniedAction.rule.permission === "ask") {
                return {
                    block: true,
                    reason: `[pi-safeguards] "${deniedAction.op} ${deniedAction.arg}" requires user approval, but environment is non-interactive`
                }
            }
            return {
                block: true,
                reason: `[pi-safeguards] Agent is not supposed to call "${deniedAction.op}" with "${deniedAction.arg}"`
            }
        }
        const approvalRequests = ruledActions.filter(action => action.rule.permission === "ask")
        for (const [i, action] of approvalRequests.entries()) {
            const totalRequests = approvalRequests.length
            const choice = await ctx.ui.select(
                `[pi-safeguards]\n\n${action.op} ${action.arg}\n\nAllow?${totalRequests > 1 ? ` (${i+1}/${totalRequests})` : ""}`,
                i+1 < totalRequests ? ["Allow", "Allow all", "Deny"] : ["Allow", "Deny"]
            )
            if (choice === undefined) {
                return { block: true, reason: `[pi-safeguards] Cancelled by user` }
            }
            if (choice === "Deny") {
                return { block: true, reason: `[pi-safeguards] Blocked by user` }
            }
            if (choice === "Allow all") {
                break
            }
        }
        return undefined
	})
}
