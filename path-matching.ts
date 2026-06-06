// home and cwd are expected to be absolute
export type PathMatcher = (home: string) => (cwd: string) => (target: string, isDir: boolean|undefined) => boolean

export const matchAnything: PathMatcher = () => () => () => true
export const matchAnyDirectory: PathMatcher = () => () => (_, isDir) => isDir !== false

// segments is always non-empty, only first segment can be ""
type NormalForm = { segments: string[], relativePrefixLen: number, onlyDir: boolean }

// How is this different from standard `node:path.normalize`?
// - x/**/.. is equivalent to x/**, not x
// - x is equivalent to **/x, not ./x
// - x/../../y is equivalent to y, not ../y
export function normalize(pattern: string): NormalForm {
    if (pattern === "") { return { segments: ["*"], relativePrefixLen: 0, onlyDir: false } }

    let onlyDir = pattern.endsWith("/")
    const parts = pattern.split("/")
    const out: string[] = [parts[0]]
    for (let [i, next] of parts.entries().drop(1)) {
        const prev = out[out.length - 1]

        if (next === "") { continue }

        if (next === ".") { continue }

        if (next === "..") {
            if (prev === "**" || prev === "" || prev === undefined) { continue }
            else if (prev === ".") { out[out.length - 1] = next }
            else if (prev === ".." || i === 1 && prev === "~") { out.push(next) }
            else { out.pop() }
            continue
        }
        
        if (next === "**") {
            if (prev === "**") { continue }
            else if (prev === "") { out.pop() }
            out.push(next)
            continue
        }

        out.push(next)
    }

    const homeRelative = parts[0] === "~"
    let relativePrefixLen = out.findIndex((segment, i) =>
        (homeRelative && i > 0 || !homeRelative) && segment !== "." && segment !== ".."
    )
    if (relativePrefixLen === -1) { relativePrefixLen = out.length }

    let segments = out
    if (out.length === 0) {
        segments = ["*"]
    } else if (out[0] === "**") {
        segments = out.length > 1 ? out.slice(1) : ["*"]
    }

    if (segments.length === 1 && out[0] === "") {
        onlyDir = true
    }

    return { segments, relativePrefixLen, onlyDir }
}

export function makeMatcher(pattern: string): PathMatcher {
    if (pattern.includes(":!")) {
        const matchers = pattern.split(":!").map(subPattern => makeMatcher(subPattern))
        return home => {
            const mainInHome = matchers[0](home)
            const exceptionsInHome = matchers.slice(1).map(e => e(home))
            return cwd => {
                const main = mainInHome(cwd)
                const exceptions = exceptionsInHome.map(e => e(cwd))
                return (target, isDir) => {
                    if (!main(target, isDir)) { return false }
                    for (let exception of exceptions) {
                        if (exception(target, isDir)) { return false }
                    }
                    return true
                }
            }
        }
    }

    const { segments, relativePrefixLen, onlyDir } = normalize(pattern)
    const leading = segments[0]

    if (segments.length === 1 && leading === "*") {
        if (onlyDir) {
            return matchAnyDirectory
        }
        return matchAnything
    }

    const isAbsolute = leading === ""

    const regexParts: string[] = []
    if (isAbsolute || relativePrefixLen > 0) {
        regexParts.push("^")
    } else {
        regexParts.push("(?:.*/|^)")
    }
    for (let [i, segment] of segments.entries().drop(relativePrefixLen)) {
        if (segment === "") { continue }

        if (segment === "**") {
            // trailing ** has its own group, see below
            if (i !== segments.length - 1) {
                regexParts.push("(?:/.+|)")  // the reason why it's all not just map().join("/")
            }

        } else {
            const sep = i > relativePrefixLen ? "/" : ""
            if (segment === "*") {
                regexParts.push(sep + "[^/]+")
            } else {
                regexParts.push(
                    sep + segment.split(/\*+/).map(part =>
                        part.split("?").map(part => RegExp.escape(part)).join(".")
                    ).join("[^/]*")
                )
            }
        }
    }
    regexParts.push(isAbsolute && segments.length === 1 ? "/" : "/?")
    const checkParent = segments[segments.length-1] === "**"
    if (checkParent) { regexParts.push("(?<child>(?<=/|^).+|)") }
    regexParts.push("$")

    const targetRegex = new RegExp(regexParts.join(""))
    function makePrefixRegex(prefix: string, childrenToCut: number): RegExp|undefined {
        const normalPrefixRegex = new RegExp(`(.*?)(?:(?:/|^)[^/]+){${childrenToCut}}/?$`)
        const normalPrefixMatch = normalPrefixRegex.exec(prefix)
        if (normalPrefixMatch === null) { return undefined }
        return new RegExp("^" + normalPrefixMatch[1] + "(?:/|$)")
    }

    return home => {
        let homeRegex: RegExp|undefined = undefined
        if (relativePrefixLen > 0 && leading === "~") {
            homeRegex = makePrefixRegex(home, relativePrefixLen - 1)
            if (!homeRegex) { return () => () => false }
        }
        return cwd => {
            let cwdRegex: RegExp|undefined = undefined
            if (relativePrefixLen > 0 && (leading === "." || leading === "..")) {
                cwdRegex = makePrefixRegex(cwd, leading === "." ? 0 : relativePrefixLen)
                if (!cwdRegex) { return () => false }
            }
            return (fullTarget, isDir) => {

                let target = fullTarget
                const prefixRegex = homeRegex || cwdRegex
                if (prefixRegex) {
                    const prefixMatch = prefixRegex.exec(fullTarget)
                    if (prefixMatch === null) { return false }
                    target = fullTarget.slice(prefixMatch[0].length)
                }

                if (checkParent) {
                    const match = targetRegex.exec(target)
                    if (match === null) { return false }
                    const isParent = !match.groups?.child
                    const onlyDirForParent = isParent || onlyDir
                    return !onlyDirForParent || onlyDirForParent && isDir !== false

                } else {
                    return (!onlyDir || onlyDir && isDir !== false)
                        && targetRegex.test(target)
                }
            }
        }
    }
}
