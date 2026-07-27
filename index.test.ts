import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import initExtension from "./index"

test("smoke", async () => {
    type EventHandler = (event: object, ctx: Partial<ExtensionContext>) => Promise<any>
    const mockHandlers = new Map<string, EventHandler>()
    const piMock: Partial<ExtensionAPI> = {
        on(event: string, handler: Function) {
            mockHandlers.set(event, handler as EventHandler)
        }
    }
    initExtension(piMock as ExtensionAPI)

    let uiAsked = false
    const mockUI = {
        notify() {},
        async select(_title, options): Promise<string> {
            uiAsked = true
            const deny = options.find(opt => opt.toLowerCase().includes("deny"))
            if (!deny) throw new Error(`Expected a deny option in: ${options}`)
            return deny
        },
    } satisfies Partial<ExtensionUIContext>
    const mockCtx = {
        ui: mockUI as unknown as ExtensionUIContext,
        cwd: "/users/rick",
        hasUI: true,
    } satisfies Partial<ExtensionContext>

    await mockHandlers.get("context")?.({}, mockCtx)
    const result = await mockHandlers.get("tool_call")?.(
        {
            toolName: "write",
            input: { path: "/" },
        },
        mockCtx
    )
    expect(uiAsked).toBe(true)
    expect(result).toEqual({
        block: true,
        reason: expect.anything(),
    })
}, { timeout: 1000 })
