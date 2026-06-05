import { ConfigJson } from "./ruleset"
import fs from "node:fs"

export function loadConfig(path: string): ConfigJson|undefined {
    const config = (function() {
        try { return JSON.parse(fs.readFileSync(path, "utf-8")) }
        catch (e) { return undefined }
    })()
    // todo: properly validate schema
    return config
}
