import { sequenceScript, makeToolMatcher } from "./tool-matching"
import { describe, expect, test } from "bun:test"

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

describe("makeToolMatcher", () => {
    describe("tool", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["*", [
                ["cat", []],
                ["cat f1", []],
                ["cat f1 f2", []],
                ["rm", []],
                ["cp", []],
            ]],
            ["ssh*", [
                ["ssh", []],
                ["ssh localhost", []],
                ["ssh-keygen", []],
                ["ssh-agent", []],
                ["sssh", undefined],
            ]],
            ["* $1", [
                ["read", undefined],
                ["read path/to/file", ["path/to/file"]],
                ["write", undefined],
                ["write path/to/file", ["path/to/file"]],
                ["edit", undefined],
                ["edit path/to/file", ["path/to/file"]],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("positionals", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["cat", [
                ["cat", []],
                ["cat f1", []],
                ["cat f1 f2", []],
                ["cat f1 f2 f3", []],
                ["catt", undefined],
                ["ccat", undefined],
            ]],
            ["cat *", [
                ["cat", undefined],
                ["cat f1", []],
                ["cat f1 f2", []],
                ["cat f1 f2 f3", []],
                ["cat -", []],
            ]],
            ["cat $1", [
                ["cat", undefined],
                ["cat f1", ["f1"]],
                ["cat f1 f2", ["f1", "f2"]],
                ["cat f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat path/to/file other/file", ["path/to/file", "other/file"]],
                ["cat -", ["-"]],
            ]],
            ["cat $1 *", [
                ["cat", undefined],
                ["cat f1", undefined],
                ["cat f1 f2", ["f1"]],
                ["cat f1 f2 f3", ["f1", "f2"]],
            ]],
            ["cat * * $1 * *", [
                ["cat", undefined],
                ["cat f1 f2 f3 f4", undefined],
                ["cat f1 f2 f3 f4 f5", ["f3"]],
                ["cat f1 f2 f3 f4 f5 f6 f7", ["f3", "f4", "f5"]],
            ]],
            ["cat * A B * C", [  // '*' is one or more
                ["cat", undefined],
                ["cat A B C", undefined],
                ["cat x A B C", undefined],
                ["cat x A B y C", []],
                ["cat x A B y z C", []],
                ["cat x y A B z u C", []],
                ["cat x A y B z C", undefined],
                ["cat x A B y z", undefined],
            ]],
            ["cp $1 dst", [
                ["cp", undefined],
                ["cp f1 dst", ["f1"]],
                ["cp f1 f2 dst", ["f1", "f2"]],
                ["cp f1 f2 f3 dst", ["f1", "f2", "f3"]],
            ]],
            ["git branch $1", [  // catch branch creation
                ["git", undefined],
                ["git branch", undefined],
                ["git branch bugfix", ["bugfix"]],
                ["git branch --no-track bugfix", ["bugfix"]],
                ["git diff branch", undefined],
                ["git diff branch bugfix", undefined],
            ]],
            // todo: allow "dd if= of=" match "dd of= if=" -> "dd [--]if= [--]of=" ?
            ["dd of=$1", [
                ["dd", undefined],
                ["dd opt", undefined],
                ["dd of=output", ["output"]],
                ["dd if=input of=output count=42", ["output"]],
                ["dd of=wrong of=output", ["wrong", "output"]],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("options", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["rm -rf $1", [
                ["rm file", undefined],
                ["rm -rf file", ["file"]],
                ["rm -fr file", ["file"]],
                ["rm -r -f file", ["file"]],
                ["rm -f -r file", ["file"]],
                ["rm -r file", undefined],
                ["rm -f file", undefined],
                ["rm file -rf", ["file"]],
                ["rm file -fr", ["file"]],
                ["rm -r file -f", ["file"]],
                ["rm -f file -r", ["file"]],
                ["rm file -r", undefined],
                ["rm file -f", undefined],
            ]],
            ["tail -f -n=", [
                ["tail", undefined],
                ["tail -f", undefined],
                ["tail -n", undefined],
                ["tail -n 17", undefined],
                ["tail -fn", undefined],
                ["tail -f -n", undefined],
                ["tail -f -n 17", []],
                ["tail -f -n17", []],
                ["tail -fn 17", []],
                ["tail -fn17", []],
                ["tail -n 17 -f", []],
                ["tail -n17 -f", []],
            ]],
            ["sort -n --output=$1", [
                ["sort --output=dest", undefined],
                ["sort -n --output=dst", ["dst"]],
                ["sort -n --output dst", ["dst"]],
                ["sort --output=dst -n", ["dst"]],
            ]],
            ["cat -sn * $1 *", [
                ["cat -sn", undefined],
                ["cat -sn f1 f2", undefined],
                ["cat -s f1 -n f2", undefined],
                ["cat -s f1 f2 -n", undefined],
                ["cat -sn f1 f2 f3", ["f2"]],
                ["cat -s f1 -n f2 f3", ["f2"]],
                ["cat f1 -n f2 -s f3 f4", ["f2", "f3"]],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("repetitions", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["cat $1 $1", [  // duplicate content
                ["cat file other", undefined],
                ["cat file file", ["file"]],
                ["cat some file other file path", ["file"]],
            ]],
            ["cat $1 around $1", [
                ["cat file around", undefined],
                ["cat file file", undefined],
                ["cat file around file", ["file"]],
                ["cat file left around right file", ["file"]],
                ["cat file between file", undefined],
            ]],
            ["sort -o=$1 $1", [  // sort in-place
                ["sort file", undefined],
                ["sort -o file file", ["file"]],
                ["sort -o f2 f1 f2 f3", ["f2"]],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("exceptions", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["rm * *:!rm * * *", [  // rm exactly 2 files at a time
                ["rm", undefined],
                ["rm f1", undefined],
                ["rm f1 f2", []],
                ["rm f1 f2 f3", undefined],
                ["rm f1 f2 f3 f4", undefined],
            ]],
            ["rm $1:!rm * *", [  // check path when rm-ed one-by-one
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2", undefined],
                ["rm f1 f2 f3 f4", undefined],
            ]],
            ["rm *:!rm $1 *", [  // synthetic: $1 == * when no $1 in main
                ["rm", undefined],
                ["rm f1", []],
                ["rm f1 f2", undefined],
                ["rm f1 f2 f3", undefined],
            ]],
            ["rm $1:!rm * $1 *:!rm * $1", [  // synthetic: $1-capture in multiple exceptions
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2", ["f1"]],
                ["rm f1 f2 f3", ["f1"]],
                ["rm f1 f2 f3 f4", ["f1"]],
            ]],
            ["mv $1 dst:!mv dst *", [  // attemp to mv into specific destination
                ["mv file dst", ["file"]],
                ["mv f1 f2 f3 dst", ["f1", "f2", "f3"]],
                ["mv dst other", undefined],
            ]],
            ["cp * $1:!cp $1 *", [  // check cp destination
                ["cp from to", ["to"]],
                ["cp f1 f2 f3 dir", ["dir"]],
                ["cp notenough", undefined],
                ["cp", undefined],
            ]],
            ["sort $1:!sort -o=$1", [  // non-in-place sort
                ["sort dst", ["dst"]],
                ["sort -o dst dst", undefined],
                ["sort -o f3 f1 f2 f3", ["f1", "f2"]],
            ]],
            ["sort $1:!sort * $1:!sort -o=$1", [  // check first sorted file in non-in-place sort
                ["sort dst", ["dst"]],
                ["sort -o dst dst", undefined],
                ["sort -o f3 f1 f2 f3", ["f1"]],
                ["sort -o f1 f1 f2 f3", undefined],
            ]],
            ["git branch:!git branch *", [  // printing current branch
                ["git branch", []],
                ["git branch bugfix", undefined],
                ["git branch --list", []],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("forced capturing", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["rm", [
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2", ["f1", "f2"]],
                ["rm f1 f2 f3", ["f1", "f2", "f3"]],
            ]],
            ["*", [
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat", undefined],
                ["cat f1", ["f1"]],
                ["cat f1 f2 f3", ["f1", "f2", "f3"]],
            ]],
            ["cat $1", [
                ["cat", undefined],
                ["cat f1", ["f1"]],
                ["cat f1 f2 f3", ["f1", "f2", "f3"]],
            ]],
            ["rm:!rm --dry-run", [
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2 f3", ["f1", "f2", "f3"]],
                ["rm --dry-run f1", undefined],
                ["rm --dry-run f1 f2 f3", undefined],
            ]],
            ["mv *:!mv $1 *:!mv * trash", [
                ["mv", undefined],
                ["mv src", undefined],
                ["mv src dst", ["dst"]],
                ["mv f1 f2 f3 dst", ["dst"]],
                ["mv src trash", undefined],
                ["mv f1 f2 f3 trash", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern, true)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })
})