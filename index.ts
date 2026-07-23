import { loadConfig } from "./config-loading"
import { makeRuleset, resolvePath, resolveRule } from "./ruleset"
import { executionSimulation, sequenceScript } from "./tool-matching"

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent"
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

        const ctxCwd = resolvePath({ homeDir }, ctx.cwd)
        const cwdSimulation = executionSimulation(ctxCwd, homeDir)
        const ruledActions = []
        for (const command of actions) {
            const cwd = cwdSimulation.cwd !== undefined ? resolvePath({ homeDir }, ...cwdSimulation.cwd) : ctxCwd
            for (const ruleMatch of resolveRule(rules, { homeDir }, cwd, command)) {
                ruledActions.push({ cmd: command, permission: ruleMatch.permission, ruleMatch })
            }
            cwdSimulation.onNext(command)
        }

        if (ruledActions.length > 0) {
            ctx.ui.notify(
                "[pi-safeguards]\n"
                    + (cwdSimulation.cwd === undefined ? "(Failed to predict CWD for some commands. Some rules might be resolved incorrectly)\n" : "")
                    + ruledActions
                        .map(action => {
                            const origin = action.ruleMatch.toolRule.origin
                            const toolPattern = action.ruleMatch.toolRule.pattern
                            const pathPattern = action.ruleMatch.pathRule.pattern
                            const originReference = origin ? origin + " → " : ""
                            const ruleDescription = `${toolPattern} → ${pathPattern} → ${action.permission}`
                            const ruleSubject = `${action.cmd.op} ${action.cmd.args.join(" ")} → ${action.ruleMatch.path}`
                            return `${ruleSubject}\n\t${originReference}${ruleDescription}`
                        })
                        .join("\n"),
                "info"
            )
        } else {
            ctx.ui.notify("[pi-safeguards] No matching rules", "info")
        }

        const deniedAction = ruledActions.find(action =>
            action.permission === "deny" || !ctx.hasUI && action.permission === "ask"
        )
        if (deniedAction) {
            const cmdLine = deniedAction.cmd.op + " " + deniedAction.cmd.args.join(' ')
            if (deniedAction.permission === "ask") {
                return {
                    block: true,
                    reason: `[pi-safeguards] Command \`${cmdLine}\` when used with path \`${deniedAction.ruleMatch.path}\` requires user approval, but environment is non-interactive`
                }
            }
            return {
                block: true,
                reason: `[pi-safeguards] Command \`${cmdLine}\` shouldn't have been used with path \`${deniedAction.ruleMatch.path}\``
            }
        }
        const approvalRequests = ruledActions.filter(action => action.permission === "ask")
        for (const [i, action] of approvalRequests.entries()) {
            const totalRequests = approvalRequests.length
            const choice = await ctx.ui.select(
                `[pi-safeguards]\n\n${action.cmd.op} ${action.cmd.args.join(' ')} → ${action.ruleMatch.path}\n\n` +
                `Allow?${totalRequests > 1 ? ` (${i+1}/${totalRequests})` : ""}`,
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
