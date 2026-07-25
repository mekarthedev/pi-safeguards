import { type PathMatcher, makePathMatcher } from "./path-matching"
import { type Command, type ToolMatcher, makeToolMatcher } from "./tool-matching"

import path from "node:path"
import url from "node:url"
import fs from "node:fs"

const permissions = {
    "allow": 0,
    "ask": 1,
    "deny": 2,
} as const
export type Permission = keyof typeof permissions

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
type Shorthand = keyof typeof permissionShorthands

const anyToolExceptIgnored = "*:!cd:!pushd:!popd:!echo:!printf:!basename:!dirname:!realpath"

const implicitlyAffectedTools: Record<string, string[]> = (function() {
    const waysToRead = [
        "grep *", "rg *", "cat", "<",
        // #todo: less, has tons of opts
        "dd ** if=(*)",
        "mv ** (*) *", "cp ** (*) *", "rsync ** (*) *",
        "od # [-t|--format=] [-j|--skip-bytes=] [-N|--read-bytes=] [-w|--width=] [-A|--address-radix=]",
        "hexdump # [-e|--format=] [-s|--skip=] [-n|--length=]",
        // #todo: xxd accepts single-dash long opts
        "xxd (*) # [-o=] [-l=]",
        "sed -e=* # [-e|--expression=]", "sed * :! sed -e=* # [-e|--expression=]",
        "awk -f=* # [-F=]", "awk * ** (*) :! awk -f=* # [-F=]",
        "uniq (*)", "sort # [-o|--output=]", "cut", "head", "tail",
        "join ** (*) # [-t=] [-a=] [-v=] [-o=] [-j=] [-1=] [-2=]",
        "curl -d=@(*) # [-d|--data=]", "curl --data-ascii=@(*)", "curl --data-binary=@(*)", "curl --data-urlencode=*@(*)",
        "curl --json=@(*)",
        // #todo: better pattern syntax to support cases like `-F name=@path;type=...`
        "curl -F=*=@(*) # [-F|--form=]", "curl -F=*=<(*) # [-F|--form=]",
        "curl -H=@(*) # [-H|--header=]",
        // Because ln creates a new path that can be used to read the original.
        "ln ** (*) * :! ln -t=* # [-t|--target-directory=]", "ln -t=* ** (*) # [-t|--target-directory=]",
    ]
    // Either deletion or creation of a path must be categorized as edit,
    // otherwise edit could be circumvented by delete+create.
    // Literally every bash command doesn't distinguish creation from modification.
    const waysToEdit = [
        ">", ">>",
        // #todo: if cp/mv/rsync src/dst is dir then need to check (dir/(filename $1))
        "cp ** * (*);", "mv ** * (*);", "rsync ** * (*);",
        "dd ** of=(*)", "truncate", "tee",
        "sed -i -e=* # [-e|--expression=]", "sed -i * :! sed -e=* # [-e|--expression=]",
        "uniq * (*)", "sort -o=(*) # [-o|--output=]",
        "curl -o=(*) # [-o|--output=]", "curl --stderr=(*)",
        "curl -D=(*) # [-D|--dump-header=]", "curl --etag-save=(*)",
        "ln ** * (*); :! ln -t=* # [-t|--target-directory=]", "ln -t=(*) # [-t|--target-directory=]",
        "mkdir", "touch",
        // #todo: chmod accepts positional with leading dash (the mode)
        "chmod # [--reference=]", "chown # [--reference=] [--from=]",
    ]
    const waysToDelete = [
        "rm", "rmdir",
        "mv ** (*) *",
        "unlink",
        "find (*) -delete",  // #todo: find accepts single-dash long opts
        "rsync --delete (*)",
        "shred",
        "srm",
    ]
    return {
        "read": waysToRead,
        "edit": [ "write", ...waysToEdit ],
        "delete": waysToDelete,  // ephemeral
        "write": [ "edit", ...waysToEdit, ...waysToDelete ],
    }
})()

type PermissionConfig = Permission | `${Permission}!`
type ShorthandConfig = Shorthand | PermissionConfig | `${Shorthand}!`
export type ConfigJson = { paths: Record<string, ShorthandConfig | Record<string, PermissionConfig> > }

type ToolRule = {
    match: ToolMatcher,
    permission: Permission,
    highSec: boolean,
    pattern: string,
    origin?: string
}
type PathRule = {
    match: ReturnType<PathMatcher>,
    toolRules: ToolRule[],
    pattern: string,
}
export type Ruleset = Record<string, PathRule[]>

function parsePermission<Config extends string, Value = Config extends `${infer T}!` ? T : Config>(
    config: Config
): { value: Value, highSec: boolean } {
    const highSec = config.endsWith("!")
    const value = (highSec ? config.slice(0, config.length - 1) : config) as Value
    return { value, highSec }
}

export function makeRuleset(homeDir: string, config: ConfigJson): Ruleset {
    const rules: Ruleset = { paths: [] }
    // #todo: numeric-like string keys are interpreted as numeric -> some rules might be out of order
    for (const [pathPattern, toolConfig] of Object.entries(config.paths).reverse()) {

        let expandedToolConfig: Record<string, PermissionConfig>
        let isHighSecShorthand = false
        if (typeof toolConfig === "string" ) {
            const { value: shorthand, highSec } = parsePermission(toolConfig)
            isHighSecShorthand = highSec
            if (!(shorthand in permissionShorthands)) {
                throw new Error(`Unknown shorthand "${shorthand}" for pattern "${pathPattern}"`)
            }
            expandedToolConfig = permissionShorthands[shorthand as Shorthand]
        } else {
            expandedToolConfig = toolConfig
        }

        const toolRules: ToolRule[] = []
        for (const [toolPattern, permissionConfig] of Object.entries(expandedToolConfig).reverse()) {
            const { value: permission, highSec: isHighSecToolRule } = parsePermission(permissionConfig)
            const highSec = isHighSecShorthand || isHighSecToolRule
            toolRules.push({
                match: makeToolMatcher(toolPattern === "*" ? anyToolExceptIgnored : toolPattern, true),
                permission,
                highSec,
                pattern: toolPattern
            })
            const implicits = implicitlyAffectedTools[toolPattern]
            if (implicits) {
                // #todo: deduplicate redundant rules when both write and edit/delete are present
                for (const implicitPattern of implicits) {
                    toolRules.push({
                        match: makeToolMatcher(implicitPattern, true),
                        permission,
                        highSec,
                        pattern: implicitPattern,
                        origin: toolPattern,
                    })
                }
            }
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
    highSec: boolean,
}
export function resolveRule(
    rules: Ruleset, pathOpts: PathResolutionOpts, cwd: string, command: Command
): RuleMatch[] {
    type MatchCandidate = { toolRule: ToolRule, pathRule: PathRule }
    const ruledPaths = new Map<string, { isDir: RuleMatch["isDir"], normal?: MatchCandidate, highSec?: MatchCandidate }>()
    for (const pathRule of rules.paths) {
        for (const toolRule of pathRule.toolRules) {
            const capturedPaths = toolRule.match(command)
            if (!capturedPaths) continue

            for (const pathRaw of capturedPaths) {
                if (pathRaw === "") continue

                const targetPath = resolvePath(pathOpts, cwd, pathRaw)
                let ruleCandidates = ruledPaths.get(targetPath)
                if (!toolRule.highSec && (ruleCandidates?.normal || ruleCandidates?.highSec)) continue
                if (!ruleCandidates) {
                    const stat = fs.statSync(targetPath, { throwIfNoEntry: false })
                    ruleCandidates = {
                        // #todo: not covered by unit tests
                        isDir: stat && stat.isDirectory(),
                        normal: undefined,
                        highSec: undefined,
                    }
                    ruledPaths.set(targetPath, ruleCandidates)
                }

                if (pathRule.match(cwd)(targetPath, ruleCandidates.isDir)) {
                    if (toolRule.highSec) {
                        const existing = ruleCandidates.highSec?.toolRule.permission
                        if (!existing || permissions[existing] < permissions[toolRule.permission]) {
                            ruleCandidates.highSec = { toolRule, pathRule }
                        }
                    } else if (!ruleCandidates.normal) {
                        ruleCandidates.normal = { toolRule, pathRule }
                    }
                }
            }
        }
    }

    const matches = []
    for (const [targetPath, candidates] of ruledPaths) {
        const rule = candidates.highSec ?? candidates.normal
        if (!rule) continue

        matches.push({
            path: targetPath,
            isDir: candidates.isDir,
            toolRule: rule.toolRule,
            pathRule: rule.pathRule,
            permission: rule.toolRule.permission,
            highSec: rule.toolRule.highSec,
        })
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
