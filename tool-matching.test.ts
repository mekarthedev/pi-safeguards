import { sequenceScript } from "./tool-matching"
import { expect, test } from "bun:test"

test("sequenceScript", () => {
    expect(sequenceScript("cat .env")).toStrictEqual([
        { op: "cat", args: [".env"] },
    ])

    expect(sequenceScript("'custom echo' \"hello str\" 'hello raw' output.json")).toStrictEqual([
        { op: "custom echo", args: ["hello str", "hello raw", "output.json"] },
    ])

    expect(sequenceScript("cd some/where && rm -rf .env")).toStrictEqual([
        { op: "cd", args: ["some/where"] },
        { op: "rm", args: ["-rf", ".env"] },
    ])

    expect(sequenceScript("cd some/where; rm -rf .env")).toStrictEqual([
        { op: "cd", args: ["some/where"] },
        { op: "rm", args: ["-rf", ".env"] },
    ])

    expect(sequenceScript("echo begin && (echo xml | xml2json.sh) && echo end")).toStrictEqual([
        { op: "echo", args: ["begin"] },
        { op: "echo", args: ["xml"] },
        { op: "xml2json.sh", args: [] },
        { op: "echo", args: ["end"] },
    ])

    expect(sequenceScript("cat $(cd nested) > output.txt")).toStrictEqual([
        { op: "cd", args: ["nested"] },
        { op: "cat", args: ["$(cd nested)"] },
        { op: ">", args: ["output.txt"] },
    ])

    expect(sequenceScript("xml2json.sh < input.xml > 'some output.json' 2> errors.log")).toStrictEqual([
        { op: "xml2json.sh", args: [] },
        { op: "<", args: ["input.xml"] },
        { op: ">", args: ["some output.json"] },
        { op: ">", args: ["errors.log"] },
    ])

    expect(sequenceScript("shell >> history.log &>> all.log &> latest.log >| protected.log")).toStrictEqual([
        { op: "shell", args: [] },
        { op: ">>", args: ["history.log"] },
        { op: ">>", args: ["all.log"] },
        { op: ">", args: ["latest.log"] },
        { op: ">", args: ["protected.log"] },
    ])

    expect(sequenceScript("cat << EOF > output.txt\nsome\nthing\nEOF")).toStrictEqual([
        { op: "cat", args: [] },
        { op: ">", args: ["output.txt"] },
    ])

    expect(sequenceScript("echo something | xml2json.sh | xxd")).toStrictEqual([
        { op: "echo", args: ["something"] },
        { op: "xml2json.sh", args: [] },
        { op: "xxd", args: [] },
    ])
})
