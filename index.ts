import { loadConfig } from "./config-loading"
import { makeRuleset, resolvePath, resolveRule, type Ruleset } from "./ruleset"
import { executionSimulation, sequenceScript, type Command } from "./tool-matching"

import { getAgentDir, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export default function (pi: ExtensionAPI) {
    const configPath = path.join(getAgentDir(), "extensions", "pi-safeguards.json")
    // note: getAgentDir() also uses homedir() instead of effective system user home
    const homeDir = resolvePath({}, os.homedir())

    let checkedInCurrentRequest = false
    let configDate: number|undefined
    let rules: Ruleset|undefined

    function reloadConfigIfNeeded() {
        if (checkedInCurrentRequest) return
        checkedInCurrentRequest = true

        const stat = fs.statSync(configPath, { throwIfNoEntry: false })
        if (stat?.mtimeMs === configDate) return
        configDate = stat?.mtimeMs

        if (stat) {
            const config = loadConfig(configPath)
            if (config) {
                rules = makeRuleset(homeDir, config)
            }
            // Keep current rules if config file was corrupted.
            // E.g. is being edited right now. Or intentionally corrupted by Skynet.
        } else {
            rules = undefined
        }
    }

    // ["context"]..thinking...["tool_call"]["tool_call"]["context"]...thinking...
    // Only reload config once before first of multiple tool calls in current llm request.
    // Use case: user sees bad tool calls and decides to modify config before next tool call.
    pi.on("context", async () => {
        checkedInCurrentRequest = false
    })

	pi.on("tool_call", async (event, ctx) => {
        reloadConfigIfNeeded()
        if (!rules) return undefined

        const actions: Command[] = []
        if (isToolCallEventType("bash", event)) {
            actions.push(...sequenceScript(event.input.command))

        } else if (isToolCallEventType("grep", event)) {
            // align with bash `grep` args layout
            actions.push({ op: event.toolName, args: [event.input.pattern, event.input.path || ctx.cwd] })

        } else if ("path" in event.input && typeof event.input.path === "string") {
            // note: bash `find` accepts pattern after path, unlike grep
            actions.push({ op: event.toolName, args: [event.input.path] })
        }

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
                            const highSec = action.ruleMatch.highSec ? "!" : ""
                            const ruleDescription = `${toolPattern} → ${pathPattern} → ${action.permission}${highSec}`
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
        const approvalRequests = ruledActions
            .filter(action => action.permission === "ask")
            .toSorted((lhs, rhs) => (lhs.ruleMatch.highSec ? -1 : 1) - (rhs.ruleMatch.highSec ? -1 : 1))
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
