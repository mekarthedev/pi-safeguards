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
            ["dd of=$1", [
                ["dd", undefined],
                ["dd opt", undefined],
                ["dd of=output", ["output"]],
                ["dd if=input of=output count=42", ["output"]],
                ["dd of=wrong of=output", ["wrong", "output"]],
            ]],
            ["git status $1", [
                ["git status -- -rf --config other", ["-rf", "--config", "other"]],
                ["git status --short -- --something", ["--something"]],
                ["git status --short -- --short", ["--short"]],
                ["git status --", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("unordered positionals", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["dd [--]if=$1 [--]of=*", [  // still requires exact match, but not a positional anymore
                ["dd", undefined],
                ["dd opt", undefined],
                ["dd if=input of=output", ["input"]],
                ["dd if=input of=output count=42", ["input"]],
                ["dd count=42 of=output if=input", ["input"]],
                ["dd if input of=output", undefined],
            ]],
            ["tar [-]czf * $1", [  // still positional, but matches any order of letters
                ["tar", undefined],
                ["tar czf tar.gz input", ["input"]],
                ["tar czvf tar.gz input", ["input"]],
                ["tar fzc tar.gz input", ["input"]],
                ["tar cz tar.gz input", undefined],
                ["tar cf tar.gz input", undefined],
                ["tar zf tar.gz input", undefined],
                ["tar cz f tar.gz input", undefined],
                ["tar cf z tar.gz input", undefined],
                ["tar tar.gz czf input", undefined],
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
            ["tail -f -n=17", [
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
                ["tail -f -n --", undefined],
                ["tail -n -v -f 17", undefined],
            ]],
            ["tail -n=*", [
                ["tail", undefined],
                ["tail -n", undefined],
                ["tail -n 17", []],
                ["tail -n17", []],
                ["tail -fn 17", []],
                ["tail -fn17", []],
                ["tail -n --", undefined],
                ["tail -n -f", undefined],
            ]],
            ["tail -n=$1", [
                ["tail", undefined],
                ["tail -n", undefined],
                ["tail -n 17", ["17"]],
                ["tail -n17", ["17"]],
                ["tail -fn 17", ["17"]],
                ["tail -fn17", ["17"]],
                ["tail -n --", undefined],
                ["tail -n -f", undefined],
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
            ["rm -rf # [-r|--recursive] [-f|--force]", [
                ["rm -f --recursive", []],
                ["rm --force -r", []],
                ["rm --force --recursive", []],
                ["rm -r -f", []],
                ["rm --recursive", undefined],
                ["rm --force", undefined],
                ["rm -r", undefined],
                ["rm -f", undefined],
                ["rm", undefined],
            ]],
            ["sort $1 # [-o|--output=]", [
                ["sort file", ["file"]],
                ["sort --output dest file", ["file"]],
                ["sort -o dest file", ["file"]],
                ["sort --output=dest file", ["file"]],
                ["sort -odest file", ["file"]],
                ["sort --output dest", undefined],
                ["sort -o dest", undefined],
            ]],
            ["sort -o * * # [-o=]", [
                ["sort -o dest", undefined],
                ["sort -o dest file", []],
                ["sort file -o dest", []],
                ["sort file -o", undefined],
                ["sort file1 file2 file3 -o dest", []],
                ["sort file1 file2 file3 -o", undefined],
                ["sort -o", undefined],
            ]],
            ["sort -o * $1 # [-o=]", [
                ["sort -o dest", undefined],
                ["sort file -o dest", ["file"]],
                ["sort file -o dest other", ["file", "other"]],
                ["sort file", undefined],
            ]],
            ["sort -n --output=$1", [
                ["sort --output=dest", undefined],
                ["sort -n --output=dst", ["dst"]],
                ["sort -n --output dst", ["dst"]],
                ["sort --output=dst -n", ["dst"]],
                ["sort -n --output", undefined],
                ["sort --output -n", undefined],
                ["sort -n --output -r", undefined],
            ]],
            ["sort -o=fixed -o=$1", [
                ["sort -o fixed -o file", ["file"]],
                ["sort -o file -o fixed", ["file"]],
                ["sort -o fixed -o fixed", ["fixed"]],
                ["sort -o other -o file", undefined],
                ["sort -o fixed", undefined],
                ["sort -o other", undefined],
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
            ["sort -o=$1 --files0-from=$1 # [-o|--output=]", [
                ["sort -o file --files0-from file", ["file"]],
                ["sort -o file -o other --files0-from other", ["other"]],
                ["sort -o of1 --output of2 --files0-from of1 --files0-from other", ["of1"]],
                ["sort -o file --files0-from other", undefined],
                ["sort -o of1 -o of2 --files0-from other1 --files0-from other2", undefined],
            ]],
            ["sort -o $1 $1 # [-o|--output=]", [
                ["sort -o path path", ["path"]],
                ["sort -o out in", undefined],
                ["sort -o out in out", ["out"]],
                ["sort -o f1 -o f2 f1 f2", ["f1", "f2"]],
                ["sort -o f1 --output f2 -o f3 f0 f1 f2 f3 f4", ["f1", "f2", "f3"]],
            ]],
            ["sort -o fixed -o $1 $1 # [-o=]", [
                ["sort -o fixed -o path path", ["path"]],
                ["sort -o path -o fixed path", ["path"]],
                ["sort -o fixed -o path fixed", undefined],
                ["sort -o path -o fixed fixed", undefined],
                ["sort -o fixed -o fixed fixed", ["fixed"]],
                ["sort -o fixed fixed", undefined],
                ["sort -o path path", undefined],
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
            ["rm *:!rm $1 *", [
                ["rm", undefined],
                ["rm f1", []],
                ["rm f1 f2", undefined],
                ["rm f1 f2 f3", undefined],
            ]],
            ["mv $1 dst:!mv dst *", [  // attemp to mv into specific destination
                ["mv file dst", ["file"]],
                ["mv f1 f2 f3 dst", ["f1", "f2", "f3"]],
                ["mv dst other", undefined],
            ]],
            ["sort -o $1:!sort * ignore # [-o=]", [
                ["sort -o ignore", ["ignore"]],
                ["sort other -o ignore", ["ignore"]],
                ["sort -o some other ignore", undefined],
                ["sort -o other", ["other"]],
            ]],
            ["sort -o $1:!sort -o=ignore", [
                ["sort any other -o some", ["some"]],
                ["sort any other -o ignore", undefined],
            ]],
            ["git branch:!git branch *", [  // printing current branch
                ["git branch", []],
                ["git branch bugfix", undefined],
                ["git branch --list", []],
            ]],
            [":!git", [
                ["git", undefined],
                ["git branch", undefined],
                ["npm", []],
            ]],
            ["git:!", [
                ["git", []],
                ["git branch", []],
                ["npm", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })

        describe("capture identity", () => {
            test.each<[string, [string, undefined|string[]][]]>([
                // only positinals in main, only positionals in exception -> exclude per positional index
                ["edit $1 :! edit * $1", [  // check first of the list of processed paths
                    ["edit first second third", ["first"]],
                    ["edit first also first other", ["first"]],
                    ["edit inplace inplace", ["inplace"]],
                    ["edit some", ["some"]],
                    ["edit", undefined],
                ]],
                ["cp * $1 :! cp $1 *", [  // check cp destination
                    ["cp from to", ["to"]],
                    ["cp f1 f2 f3 dir", ["dir"]],
                    ["cp same same", ["same"]],
                    ["cp notenough", undefined],
                    ["cp", undefined],
                ]],
                ["rm $1 :! rm * $1 * :! rm * $1", [
                    ["rm", undefined],
                    ["rm f1", ["f1"]],
                    ["rm f1 f2", ["f1"]],
                    ["rm f1 f2 f3", ["f1"]],
                    ["rm f1 f2 f3 f4", ["f1"]],
                    ["rm same same same", ["same"]],
                ]],

                // only positionals in main, only opts in exception -> exclude per value
                ["sort $1 :! sort -o=$1", [  // check non-output paths
                    ["sort dst", ["dst"]],
                    ["sort -o dst dst", undefined],
                    ["sort -o f3 f1 f2 f3", ["f1", "f2"]],
                ]],
                ["sort * $1 :! sort -o=$1", [  // check non-output paths starting from second
                    ["sort dst", undefined],
                    ["sort -o dst dst", undefined],
                    ["sort -o f3 f1 f2 f3 f4", ["f2", "f4"]],
                    ["sort f1 f2 f3 f4 -o f3", ["f2", "f4"]],
                ]],

                // only positionals in main, positionals+opts in exception -> exclude per positional index
                ["sort $1 :! sort -o=$1 * $1 *", [
                    ["sort first middle last", ["first", "middle", "last"]],
                    ["sort first middle last -o first", ["first", "middle", "last"]],
                    ["sort first middle last -o middle", ["first", "last"]],
                    ["sort first middle middle last", ["first", "middle", "last"]],
                    ["sort first middle middle last -o middle", ["first", "last"]],
                    ["sort first middle middle last -o middle -o first", ["first", "last"]],
                    ["sort same same same -o same", ["same"]],
                ]],
                ["sort $1 :! sort * $1 :! sort -o=$1", [  // check first sorted file if it isn't output
                    ["sort dst", ["dst"]],
                    ["sort -o dst dst", undefined],
                    ["sort -o f2 f1 f2 f3", ["f1"]],
                    ["sort -o f3 f1 f2 f3", ["f1"]],
                    ["sort f1 f2 -o f3 f3", ["f1"]],
                    ["sort -o f1 f1 f2 f3", undefined],
                    ["sort -o f same same", ["same"]],
                ]],

                // positionals+opts in main -> same as with only positionals in main
                ["sort -o=$1 --files0-from=$1 $1 :! sort * $1 *", [
                    ["sort first mid last -o first", undefined],
                    ["sort first mid last -o first --files0-from last", undefined],
                    ["sort first mid last -o first --files0-from first", ["first"]],
                    ["sort first mid last -o mid", undefined],
                    ["sort first mid last -o mid --files0-from mid", undefined],
                    ["sort head tail tail -o tail --files0-from tail", ["tail"]],
                    ["sort first mid mid last -o mid --files0-from mid", undefined],
                    ["sort head tail tail -o head -o tail --files0-from head --files0-from tail", ["head", "tail"]],
                    ["sort first mid mid last -o first -o mid --files0-from first --files0-from mid", ["first"]],
                    ["sort same same same -o same --files0-from same", ["same"]],
                ]],
                ["sort -o=$1 $1 :! sort --files0-from=$1", [
                    ["sort f -o f", ["f"]],
                    ["sort f -o f --files0-from f", undefined],
                    ["sort f g -o g --files0-from f", ["g"]],
                    ["sort f g -o f -o g --files0-from f", ["g"]],
                ]],
                ["sort -o=$1 $1 :! sort --files0-from=$1 * $1", [
                    ["sort f1 f2 f3 -o f1 -o f3", ["f1", "f3"]],
                    ["sort f1 f2 f3 f4 f5 -o f1 -o f2 -o f4 --files0-from=f4 --files0-from=f5", ["f1", "f2"]],
                    ["sort same same same -o same --files0-from same", ["same"]],
                ]],

                // only opts in main -> exclude by value
                ["grep -f=$1 :! grep * $1", [
                    ["grep -f f1 -f f4 pattern f1 f2 f3", ["f4"]],
                    ["grep -f f1 -f f2 pattern f1 f2 f3", undefined],
                    ["grep -f x pattern x y", undefined],
                    ["grep -f same -f same pattern same", undefined],
                ]],
                ["grep --include=$1 :! grep -f=$1", [
                    ["grep --include f1 --include f2 -f f1 pattern path", ["f2"]],
                    ["grep --include f1 --include f2 pattern path", ["f1", "f2"]],
                    ["grep --include f1 --include f2 -f f1 -f f2 pattern path", undefined],
                    ["grep -f x pattern x y", undefined],
                    ["grep --include same --include same -f same pattern path", undefined],
                ]],
                ["grep --include=$1 :! grep -f=$1 * $1", [
                    ["grep --include f1 --include f2 -f f1 pattern f1 f2", ["f2"]],
                    ["grep --include f1 --include f2 pattern f1 f2", ["f1", "f2"]],
                    ["grep --include f1 --include f2 -f f1 -f f2 pattern f1 f2", undefined],
                    ["grep --include same --include same -f same pattern other", ["same"]],
                    ["grep --include same --include same -f same pattern same", undefined],
                ]],
            ])("%s", (pattern, cases) => {
                const matcher = makeToolMatcher(pattern)
                for (const [cmdLine, expectedMatches] of cases) {
                    const cmd = sequenceScript(cmdLine)[0]
                    expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
                }
            })
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
            ["sort -o #[-o=]", [
                ["sort", undefined],
                ["sort f1", undefined],
                ["sort -o f1", undefined],
                ["sort -o -- f1", ["f1"]],
                ["sort f1 f2 -o f3", ["f1", "f2"]],
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