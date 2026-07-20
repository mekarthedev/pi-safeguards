import { sequenceScript, executionSimulation, makeToolMatcher } from "./tool-matching"
import { describe, expect, test } from "bun:test"

test("sequenceScript", () => {
    expect(sequenceScript("cat .env")).toStrictEqual([
        { op: "cat", args: [".env"] },
    ])

    expect(sequenceScript("'custom echo' \"hello str\" 'hello raw' output.json")).toStrictEqual([
        { op: "custom echo", args: ["hello str", "hello raw", "output.json"] },
    ])
    expect(sequenceScript("echo \\( \"\\(\" '\\('")).toStrictEqual([
        { op: "echo", args: ["(", "(", "\\("] },
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
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["xml"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "xml2json.sh", args: [] },
        { op: ")", args: [] },
        { op: ")", args: [] },
        { op: "echo", args: ["end"] },
    ])

    expect(sequenceScript("cat $(cd nested) > output.txt")).toStrictEqual([
        { op: "(", args: [] },
        { op: "cd", args: ["nested"] },
        { op: ")", args: [] },
        { op: "cat", args: ["$(cd nested)"] },
        { op: ">", args: ["output.txt"] },
    ])

    expect(sequenceScript("(cd front && bun test); echo $(cd back && pwd)")).toStrictEqual([
        { op: "(", args: [] },
        { op: "cd", args: ["front"] },
        { op: "bun", args: ["test"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "cd", args: ["back"] },
        { op: "pwd", args: [] },
        { op: ")", args: [] },
        { op: "echo", args: ["$(cd back && pwd)"] },
    ])

    expect(sequenceScript("sort $(cat $(echo f.txt)) $(uniq $(echo g.txt))")).toStrictEqual([
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["f.txt"] },
        { op: ")", args: [] },
        { op: "cat", args: ["$(echo f.txt)"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["g.txt"] },
        { op: ")", args: [] },
        { op: "uniq", args: ["$(echo g.txt)"] },
        { op: ")", args: [] },
        { op: "sort", args: ["$(cat $(echo f.txt))", "$(uniq $(echo g.txt))"] },
    ])

    expect(sequenceScript("sort <(cat <(echo some)) <(uniq <(echo thing))")).toStrictEqual([
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["some"] },
        { op: ")", args: [] },
        { op: "cat", args: ["<(echo some)"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["thing"] },
        { op: ")", args: [] },
        { op: "uniq", args: ["<(echo thing)"] },
        { op: ")", args: [] },
        { op: "sort", args: ["<(cat <(echo some))", "<(uniq <(echo thing))"] },
    ])

    expect(sequenceScript("cat `echo f.txt`")).toStrictEqual([
        { op: "(", args: [] },
        { op: "echo", args: ["f.txt"] },
        { op: ")", args: [] },
        { op: "cat", args: ["`echo f.txt`"] },
    ])

    expect(sequenceScript("echo something | xml2json.sh |& xxd")).toStrictEqual([
        { op: "(", args: [] },
        { op: "echo", args: ["something"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "xml2json.sh", args: [] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "xxd", args: [] },
        { op: ")", args: [] },
    ])

    expect(sequenceScript("echo 42 & { echo 17; } & { echo 23 & } && echo 69 &")).toStrictEqual([
        { op: "(", args: [] },
        { op: "echo", args: ["42"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["17"] },
        { op: ")", args: [] },
        { op: "(", args: [] },
        { op: "(", args: [] },
        { op: "echo", args: ["23"] },
        { op: ")", args: [] },
        { op: "echo", args: ["69"] },
        { op: ")", args: [] },
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
})

describe("executionSimulation", () => {
    test.each<[string, [string, string[]|undefined][]]>([
        ["cd", [
            ["cd 1", ["/", "1"]],
            ["echo hello", ["/", "1"]],
            ["cd 2", ["/", "1", "2"]],
            ["cd ..", ["/", "1", "2", ".."]],
            ["cd /root", ["/", "1", "2", "..", "/root"]],
            ["cd", ["/home"]],
            ["cd 3", ["/home", "3"]],
            ["cd -L 4", ["/home", "3", "4"]],
            ["cd -P 5", ["/home", "3", "4", "5"]],
            ["cd -L", ["/home"]],
        ]],
        ["pushd/popd", [
            ["pushd 1", ["/", "1"]],
            ["pushd 2", ["/", "1", "2"]],
            ["pushd 3", ["/", "1", "2", "3"]],
            ["popd", ["/", "1", "2"]],
            ["pushd 4", ["/", "1", "2", "4"]],
            ["popd", ["/", "1", "2"]],
            ["popd", ["/", "1"]],
            ["pushd 5", ["/", "1", "5"]],
            ["popd", ["/", "1"]],
            ["popd", ["/"]],
            ["popd", undefined],
        ]],
        ["oldpwd", [
            ["cd 1", ["/", "1"]],
            ["cd 2", ["/", "1", "2"]],
            ["cd -", ["/", "1"]],
            ["cd -", ["/", "1", "2"]],
            ["pushd 3", ["/", "1", "2", "3"]],
            ["pushd 4", ["/", "1", "2", "3", "4"]],
            ["cd -", ["/", "1", "2", "3"]],
            ["popd", ["/", "1", "2", "3"]],
            ["popd", ["/", "1", "2"]],
            ["cd -", ["/", "1", "2", "3"]],
            ["cd", ["/home"]],
            ["cd -", ["/", "1", "2", "3"]],
        ]],
        ["subshell", [
            ["pushd 1", ["/", "1"]],
            ["pushd 2", ["/", "1", "2"]],
            ["cd 3", ["/", "1", "2", "3"]],
            ["(", ["/", "1", "2", "3"]],
            ["cd 4", ["/", "1", "2", "3", "4"]],
            [")", ["/", "1", "2", "3"]],
            ["(", ["/", "1", "2", "3"]],
            ["cd -", ["/", "1", "2"]],
            ["cd 5", ["/", "1", "2", "5"]],
            [")", ["/", "1", "2", "3"]],
            ["cd -", ["/", "1", "2"]],
            ["cd 3", ["/", "1", "2", "3"]],
            ["(", ["/", "1", "2", "3"]],
            ["pushd 6", ["/", "1", "2", "3", "6"]],
            [")", ["/", "1", "2", "3"]],
            ["(", ["/", "1", "2", "3"]],
            ["popd", ["/", "1"]],
            [")", ["/", "1", "2", "3"]],
            ["popd", ["/", "1"]],
        ]],
    ])("%s", (_, cases) => {
        const sim = executionSimulation("/", "/home")
        expect(sim.cwd).toStrictEqual(["/"])
        for (const [i, [cmdLine, expectedCwd]] of cases.entries()) {
            sim.onNext(["(", ")"].includes(cmdLine) ? { op: cmdLine, args: [] } : sequenceScript(cmdLine)[0])
            expect(sim.cwd, `:${i}: ${cmdLine}`).toStrictEqual(expectedCwd)
        }
    })
})

describe("makeToolMatcher", () => {
    describe("command name", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["*", [
                ["cat", []],
                ["cat f1", []],
                ["cat f1 f2", []],
                ["rm", []],
                ["cp", []],
            ]],
            ["cat", [
                ["cat", []],
                ["cat f1", []],
                ["cat f1 f2 f3", []],
                ["catt", undefined],
                ["ccat", undefined],
            ]],
            ["ssh*", [
                ["ssh", []],
                ["ssh localhost", []],
                ["ssh-keygen", []],
                ["ssh-agent", []],
                ["sssh", undefined],
            ]],
            ["* (*)", [
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
            ["cat *", [  // at least one positional exists
                ["cat", undefined],
                ["cat f1", []],
                ["cat f1 f2", []],
                ["cat f1 f2 f3", []],
                ["cat -", []],
                ["cat --", undefined],
                ["cat -- f1", []],
                ["cat \"\"", []],
            ]],
            ["cat (*)", [  // 1st positional
                ["cat", undefined],
                ["cat f1", ["f1"]],
                ["cat f1 f2", ["f1"]],
                ["cat f1 f2 f3", ["f1"]],
                ["cat path/to/file other/file", ["path/to/file"]],
                ["cat -", ["-"]],
                ["cat --", undefined],
                ["cat -- f1", ["f1"]],
                ["cat \"\"", [""]],
            ]],
            ["cat **", [  // same as just "cat"
                ["cat", []],
                ["echo", undefined],
                ["cat f1", []],
                ["cat f1 f2 f3", []],
                ["cat -", []],
                ["cat --", []],
            ]],
            ["grep pattern **", [  // same as just "grep pattern"
                ["grep pattern", []],
                ["grep pattern a b c", []],
                ["grep", undefined],
                ["grep other", undefined],
                ["grep other pattern", undefined],
            ]],
            ["cat ** (*)", [  // any positional
                ["cat", undefined],
                ["cat f1", ["f1"]],
                ["cat f1 f2", ["f1", "f2"]],
                ["cat f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat path/to/file other/file", ["path/to/file", "other/file"]],
                ["cat -", ["-"]],
                ["cat --", undefined],
                ["cat -- f1", ["f1"]],
                ["cat -- f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat f1 -- f2 f3", ["f1", "f2", "f3"]],
                ["cat f1 f2 -- f3", ["f1", "f2", "f3"]],
                ["cat f1 f2 f3 --", ["f1", "f2", "f3"]],
            ]],
            ["cat * * (*) * *", [  // 3rd positional out of at least 5
                ["cat", undefined],
                ["cat f1 f2", undefined],
                ["cat f1 f2 f3 f4", undefined],
                ["cat f1 f2 f3 f4 f5", ["f3"]],
                ["cat f1 f2 f3 f4 f5 f6 f7", ["f3"]],
            ]],
            ["cat * * ** (*) * *", [  // any middle positional out of at least 5
                ["cat", undefined],
                ["cat f1 f2", undefined],
                ["cat f1 f2 f3 f4", undefined],
                ["cat f1 f2 f3 f4 f5", ["f3"]],
                ["cat f1 f2 f3 f4 f5 f6 f7", ["f3", "f4", "f5"]],
            ]],
            ["cat ** (*) ** (*) ** (*)", [  // any positional out of at least 3
                ["cat", undefined],
                ["cat f1 f2", undefined],
                ["cat f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat f1 f2 f3 f4", ["f1", "f2", "f3", "f4"]],
                ["cat f1 f2 f3 f4 f5 f6 f7", ["f1", "f2", "f3", "f4", "f5", "f6", "f7"]],
            ]],
            ["cat (*) (*) * ** (*)", [  // any positional except 3rd out of at least 4
                ["cat", undefined],
                ["cat f1 f2", undefined],
                ["cat f1 f2 f3", undefined],
                ["cat f1 f2 f3 f4", ["f1", "f2", "f4"]],
                ["cat f1 f2 f3 f4 f5 f6 f7", ["f1", "f2", "f4", "f5", "f6", "f7"]],
            ]],
            ["cat * A B * C", [
                ["cat", undefined],
                ["cat A B C", undefined],
                ["cat x A B C", undefined],
                ["cat x A B y C", []],
                ["cat x y A B z C", undefined],
                ["cat x A B y z C", undefined],
                ["cat x y A B z u C", undefined],
                ["cat x A y B z C", undefined],
                ["cat x A B y z", undefined],
            ]],
            ["cat ** (*) X", [
                ["cat", undefined],
                ["cat X", undefined],
                ["cat a X", ["a"]],
                ["cat a b X", ["b"]],
                ["cat a b", undefined],
                ["cat a X b X", ["a", "b"]],
                ["cat a b X c d X", ["b", "d"]],
                ["cat a X X", ["a", "X"]],
                ["cat a X a X a X", ["a"]],
            ]],
            ["git branch (*)", [  // catch branch creation
                ["git", undefined],
                ["git branch", undefined],
                ["git branch bugfix", ["bugfix"]],
                ["git branch --no-track bugfix", ["bugfix"]],
                ["git branch -- --no-track", ["--no-track"]],
                ["git diff branch", undefined],
                ["git diff branch bugfix", undefined],
            ]],
            ["git status ** (*)", [
                ["git status -- -rf --config other", ["-rf", "--config", "other"]],
                ["git status --short -- --something", ["--something"]],
                ["git status --short -- --short", ["--short"]],
                ["git status --", undefined],
            ]],

            ["cat ** .ssh/*", [
                ["cat .ssh/a", []],
                ["cat a .ssh/b c", []],
                ["cat a .ssh/b c .ssh/d", []],
                ["cat a b c d", undefined],
                ["cat a", undefined],
            ]],
            ["cat ** (.ssh/*)", [
                ["cat .ssh/a", [".ssh/a"]],
                ["cat a .ssh/b c", [".ssh/b"]],
                ["cat a .ssh/b c .ssh/d", [".ssh/b", ".ssh/d"]],
                ["cat a b c d", undefined],
                ["cat a", undefined],
            ]],
            ["dd ** of=(*)", [
                ["dd", undefined],
                ["dd of", undefined],
                ["dd of=", [""]],
                ["dd of=output", ["output"]],
                ["dd if=input of=output count=42", ["output"]],
                ["dd of=multiple if=input of=output", ["multiple", "output"]],
            ]],
            ["dd ** of=(/tmp/*)", [
                ["dd", undefined],
                ["dd of", undefined],
                ["dd of=", undefined],
                ["dd of=output", undefined],
                ["dd of=/tmp/output", ["/tmp/output"]],
                ["dd if=input of=/tmp/output count=42", ["/tmp/output"]],
                ["dd of=/tmp/multiple if=input of=/tmp/output", ["/tmp/multiple", "/tmp/output"]],
            ]],
            ["lint (*):(*):(*)", [
                ["lint a:b:c", ["a", "b", "c"]],
                ["lint a:b", undefined],
                ["lint a", undefined],
                ["lint", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    /* #todo describe("unordered positionals", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["dd [--]if=(*) [--]of=*", [  // not a positional anymore
                ["dd", undefined],
                ["dd opt", undefined],
                ["dd if=input of=output", ["input"]],
                ["dd if=input of=output count=42", ["input"]],
                ["dd count=42 of=output if=input", ["input"]],
                ["dd if input of=output", undefined],
            ]],
            ["tar [-]czf * (*)", [  // still positional, but matches any order of letters
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
    */

    describe("options", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["rm -rf ** (*)", [
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
            ["rm -- -rf", [
                ["rm -- -rf", []],
                ["rm -rf -- -rf", []],
                ["rm -rf", undefined],
                ["rm -rf --", undefined],
                ["rm -- -fr", undefined],
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
                ["tail -n -f", undefined],
                ["tail -n -- 17", undefined],
                ["tail -n --", undefined],
                ["tail -- -n 17", undefined],
                ["tail -- -n17", undefined],
            ]],
            ["tail -n=(*)", [
                ["tail", undefined],
                ["tail -n", undefined],
                ["tail -n 17", ["17"]],
                ["tail -n17", ["17"]],
                ["tail -fn 17", ["17"]],
                ["tail -fn17", ["17"]],
                ["tail -n -f", undefined],
                ["tail -n -- 17", undefined],
                ["tail -n --", undefined],
                ["tail -- -n 17", undefined],
                ["tail -- -n17", undefined],
            ]],
            ["cat -sn * ** (*) *", [
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
            ["sort (*) # [-o|--output=]", [
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
            ["sort -o * ** (*) # [-o=]", [
                ["sort -o dest", undefined],
                ["sort file -o dest", ["file"]],
                ["sort file -o dest other", ["file", "other"]],
                ["sort file", undefined],
            ]],
            ["sort -n --output=(*)", [
                ["sort --output=dest", undefined],
                ["sort -n --output=dst", ["dst"]],
                ["sort -n --output dst", ["dst"]],
                ["sort --output=dst -n", ["dst"]],
                ["sort -n --output", undefined],
                ["sort --output -n", undefined],
                ["sort -n --output -r", undefined],
            ]],
            ["grep -f=a -f=b -f=(*)", [
                ["grep -f a -f b -f x", ["x"]],
                ["grep -f x -f b -f a", ["x"]],
                ["grep -f b -f x -f a", ["x"]],
                ["grep -f a -f b -f a", ["a"]],
                ["grep -f a -f x -f y", undefined],
                ["grep -f a -e b -f x", undefined],
                ["grep -f a -f b -e x", undefined],
                ["grep -f a -f b", undefined],
                ["grep -f x", undefined],
            ]],
            ["grep -f=(*) --include=(*)", [
                ["grep -f a --include x", ["a", "x"]],
                ["grep -f a -f b -f c --include x --include y --exclude z", ["a", "b", "c", "x", "y"]],
                ["grep -f a -f same --include x --include same", ["a", "same", "x"]],
                ["grep -f a", undefined],
                ["grep --include x", undefined],
            ]],
            ["grep -f=(*) * ** (*)", [
                ["grep x a -f b", ["b", "a"]],
                ["grep x -f a -f b c d", ["a", "b", "c", "d"]],
                ["grep x -f a", undefined],
                ["grep x a", undefined],
            ]],
            ["docker run -v=(*):*", [
                ["docker run -v /host:/c image", ["/host"]],
                ["docker run -v /host/1:/c/1 -v /host/2:/c/2 image", ["/host/1", "/host/2"]],
                ["docker run -v /host image", undefined],
                ["docker run -v /host: image", ["/host"]],
            ]],
            ["docker run -v=(/.ssh/*):/www/*", [
                ["docker run -v /.ssh/1:/www/a -v /.ssh/2:/www/b image", ["/.ssh/1", "/.ssh/2"]],
                ["docker run -v /.ssh/1:/.ssh/a -v /.ssh/2:/www/b -v /dist/3:/www/c image", ["/.ssh/2"]],
                ["docker run -v /.ssh/1:/.ssh/a image", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("end-of-line anchor", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["mount ; # [-t=]", [
                ["mount", []],
                ["mount -t ext4", []],
                ["mount /dir", undefined],
            ]],
            ["mount; # [-t=]", [
                ["mount", []],
                ["mount -t ext4", []],
                ["mount /dir", undefined],
            ]],
            ["cat file ;", [
                ["cat file", []],
                ["cat file other", undefined],
                ["cat -v file", []],
                ["cat", undefined],
                ["cat -v", undefined],
            ]],
            ["cat file;", [
                ["cat file", []],
                ["cat file other", undefined],
                ["cat -v file", []],
                ["cat", undefined],
                ["cat -v", undefined],
            ]],
            ["cat (*) ;", [
                ["cat file", ["file"]],
                ["cat file other", undefined],
                ["cat -v file", ["file"]],
                ["cat", undefined],
                ["cat -v", undefined],
            ]],
            ["cat (*);", [
                ["cat file", ["file"]],
                ["cat file other", undefined],
                ["cat -v file", ["file"]],
                ["cat", undefined],
                ["cat -v", undefined],
            ]],
            ["cat ** ;", [
                ["cat", []],
                ["echo", undefined],
                ["cat f1", []],
                ["cat f1 f2 f3", []],
                ["cat -", []],
                ["cat --", []],
            ]],
            ["cat **;", [
                ["cat", []],
                ["echo", undefined],
                ["cat f1", []],
                ["cat f1 f2 f3", []],
                ["cat -", []],
                ["cat --", []],
            ]],
            ["cp ** (*) ** dst;", [  // check paths cp-ed into specific destination
                ["cp", undefined],
                ["cp dst", undefined],
                ["cp f1 dst", ["f1"]],
                ["cp f1 f2 dst", ["f1", "f2"]],
                ["cp f1 f2 f3 dst", ["f1", "f2", "f3"]],
                ["cp f1 dst other", undefined],
                ["cp dst dst", ["dst"]],
                ["cp f1 dst f2 dst", ["f1", "dst", "f2"]],
            ]],
            ["cp ** * (*);", [  // check cp destination
                ["cp from to", ["to"]],
                ["cp f1 f2 f3 dir", ["dir"]],
                ["cp same same", ["same"]],
                ["cp notenough", undefined],
                ["cp", undefined],
            ]],
            ["cat ** * (*) (*) (*);", [  // last 3 positionals out of at least 4
                ["cat a b", undefined],
                ["cat a b c", undefined],
                ["cat a b c d", ["b", "c", "d"]],
                ["cat a b c d e f", ["d", "e", "f"]],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("backreferences", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["cat ** (*) ** $1", [  // duplicate content
                ["cat file other", undefined],
                ["cat file file", ["file"]],
                ["cat some file other file path", ["file"]],
            ]],
            ["cat ** (*) ** around ** $1", [
                ["cat file around", undefined],
                ["cat file file", undefined],
                ["cat file around file", ["file"]],
                ["cat file left around right file", ["file"]],
                ["cat file between file", undefined],
            ]],
            ["cat ** src/(*.ts) ** test/$1", [
                ["cat src/same.ts test/same.ts", ["same.ts"]],
                ["cat src/same.ts src/some.ts test/same.ts test/other.ts", ["same.ts"]],
                ["cat src/a.ts src/b.ts test/c.ts src/c.ts src/d.ts test/a.ts test/d.ts", ["a.ts", "d.ts"]],
                ["cat src/same test/same", undefined],
                ["cat src/some.ts test/src/some.ts", undefined],
                ["cat src/test/some.ts test/some.ts", undefined],
                ["cat src/test/some.ts test/test/some.ts", ["test/some.ts"]],
                ["cat test/same.ts src/same.ts", undefined],
                ["cat src/same.ts same.ts", undefined],
            ]],
            ["rm ** (*) ** $1-*.bak", [
                ["rm a a-0.bak", ["a"]],
                ["rm a b c d b-1.bak d-2.bak", ["b", "d"]],
                ["rm a b a a-bak a.bak b-1.bak", ["b"]],
                ["rm a b c", undefined],
            ]],
            ["cat ** (*)/$1.ts", [
                ["cat a/a.ts b/index.ts c/c.ts", ["a", "c"]],
                ["cat a/x.ts b/y.ts c/z.ts", undefined],
            ]],
            ["sort -o=(*) --files0-from=$1 # [-o|--output=]", [
                ["sort -o file --files0-from file", ["file"]],
                ["sort -o file -o other --files0-from other", ["other"]],
                ["sort -o of1 --output of2 --files0-from of1 --files0-from other", ["of1"]],
                ["sort -o file --files0-from other", undefined],
                ["sort -o of1 -o of2 --files0-from other1 --files0-from other2", undefined],
            ]],
            ["sort -o (*) ** $1 # [-o|--output=]", [
                ["sort -o path path", ["path"]],
                ["sort -o out in", undefined],
                ["sort -o out in out", ["out"]],
                ["sort -o f1 -o f2 -o f3 -o f4 f2 f3", ["f2", "f3"]],
                ["sort -o f1 --output f2 -o f3 f0 f1 f2 f3 f4", ["f1", "f2", "f3"]],
            ]],
            ["grep -f=(*) -f=$1", [
                ["grep -f path -f path", ["path"]],
                ["grep -f path -f other", undefined],
                ["grep -f a -f b -f c -f b -f d -f c", ["b", "c"]],
                ["grep -f a -f b -f c -f d", undefined],
            ]],
            ["grep -f=(*) ** $1 ** $1", [
                ["grep -f path path path", ["path"]],
                ["grep -f f1 -f f2 f1 f2", undefined],
                ["grep -f f1 -f f2 f1 f2 f1", ["f1"]],
                ["grep -f f1 -f f2 f1 f2 f2", ["f2"]],
            ]],
            ["grep -f=(*) -f=$1 -f=$1", [
                ["grep -f path -f path -f path", ["path"]],
                ["grep -f path -f other -f path -f other", undefined],
                ["grep -f a -f b -f c -f b -f d -f b -f c", ["b"]],
                ["grep -f a -f b -f c -f d", undefined],
            ]],
            ["grep -f (*) -f copies/$1 # [-f=]", [
                ["grep -f same -f copies/same", ["same"]],
                ["grep -f same -f same", undefined],
                ["grep -f some -f copies/other", undefined],
                ["grep -f a -f b -f c -f copies/a -f copies/c -f copies/copies/a", ["a", "c", "copies/a"]],
                ["grep -f a -f b -f copies/c -f copies/d", undefined],
            ]],
            ["grep -f fixed -f (*) * ** $1 # [-f=]", [
                ["grep -f fixed -f path a-z path", ["path"]],
                ["grep -f path -f fixed a-z path", ["path"]],
                ["grep -f fixed -f path a-z fixed", undefined],
                ["grep -f path -f fixed a-z fixed", undefined],
                ["grep -f fixed -f fixed a-z fixed", ["fixed"]],
                ["grep -f fixed a-z fixed", undefined],
                ["grep -f path a-z path", undefined],
            ]],
            ["grep -f=(*).md --exclude=$1.ts * ** src/$1", [
                ["grep -f a.md --exclude a.ts .* src/a", ["a"]],
                ["grep -f a.md --exclude b.ts .* src/a", undefined],
                ["grep -f a.md --exclude a.ts .* src/b", undefined],
                ["grep -f a.md -f b.md -f c.md -f d.md --exclude b.ts --exclude c.ts --exclude d.ts .* src/a src/b src/d", ["b", "d"]],
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
        describe("simple", () => {
            test.each<[string, [string, undefined|string[]][]]>([
                ["rm * * :! rm * * *", [  // rm exactly 2 files at a time
                    ["rm", undefined],
                    ["rm f1", undefined],
                    ["rm f1 f2", []],
                    ["rm f1 f2 f3", undefined],
                    ["rm f1 f2 f3 f4", undefined],
                ]],
                ["rm (*) :! rm * *", [  // check path when rm-ing one-by-one
                    ["rm", undefined],
                    ["rm f1", ["f1"]],
                    ["rm f1 f2", undefined],
                    ["rm f1 f2 f3 f4", undefined],
                ]],
                ["rm * :! rm (*) *", [
                    ["rm", undefined],
                    ["rm f1", []],
                    ["rm f1 f2", undefined],
                    ["rm f1 f2 f3", undefined],
                ]],
                ["rm ** (*) :! rm * * *;", [  // all paths except when removing exactly 3 at a time
                    ["rm", undefined],
                    ["rm f1", ["f1"]],
                    ["rm f1 f2", ["f1", "f2"]],
                    ["rm f1 f2 f3", undefined],
                    ["rm f1 f2 f3 f4", ["f1", "f2", "f3", "f4"]],
                    ["rm same same", ["same"]],
                    ["rm same same same", undefined],
                    ["rm same same same same", ["same"]],
                ]],
                ["mv ** (*) ** /trash; :! mv ** .ssh/* *", [  // moving to trash, except when it's important
                    ["mv f1 /trash", ["f1"]],
                    ["mv f1 f2 f3 /trash", ["f1", "f2", "f3"]],
                    ["mv f1 f2 /trash f3", undefined],
                    ["mv .ssh/f1 f2 f3 /trash", undefined],
                    ["mv f1 .ssh/f2 f3 /trash", undefined],
                    ["mv f1 f2 .ssh/f3 /trash", undefined],
                    ["mv f1 .ssh/f2 /trash f3", undefined],
                ]],
                ["dd ** if=(*) :! dd ** of=*", [  // just reading, no writing
                    ["dd if=input", ["input"]],
                    ["dd if=input count=42", ["input"]],
                    ["dd if=input count=42 of=output", undefined],
                    ["dd of=output count=42 if=input", undefined],
                    ["dd count=42 if=same of=same", undefined],
                ]],
                ["sort -o (*) :! sort * ignore # [-o=]", [
                    ["sort -o ignore", ["ignore"]],
                    ["sort other -o ignore", ["ignore"]],
                    ["sort -o some other ignore", undefined],
                    ["sort -o other", ["other"]],
                ]],
                ["sort -o (*) :! sort -o=ignore", [
                    ["sort any other -o some", ["some"]],
                    ["sort any other -o ignore", undefined],
                ]],
                ["git branch :! git branch *", [  // just printing current branch
                    ["git branch", []],
                    ["git branch bugfix", undefined],
                    ["git branch --list", []],
                ]],
                ["git prune :! git prune -n # [-n|--dry-run] :! git prune a12bc3", [
                    ["git prune", []],
                    ["git prune d45ef6", []],
                    ["git prune --dry-run", undefined],
                    ["git prune --dry-run d45ef6", undefined],
                    ["git prune a12bc3", undefined],
                    ["git prune --dry-run a12bc3", undefined],
                ]],
                [":! git", [
                    ["git", undefined],
                    ["git branch", undefined],
                    ["npm", []],
                ]],
                ["git :!", [
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
        })

        describe("capturing", () => {
            test.each<[string, [string, undefined|string[]][]]>([  // always exclude by value
                ["rm (*) :! rm * ** (*)", [
                    ["rm same same", undefined],
                    ["rm first also first other", undefined],
                    ["rm first second third", ["first"]],
                    ["rm some", ["some"]],
                ]],
                ["rm * ** (*) :! rm (*)", [
                    ["rm same same", undefined],
                    ["rm first also first other", ["also", "other"]],
                    ["rm first second third", ["second", "third"]],
                ]],
                ["echo (*) ** (*); :! echo * ** (*) *", [  // first/last word if not used in the middle
                    ["echo hello world", ["hello", "world"]],
                    ["echo quick brown fox jumps", ["quick", "jumps"]],
                    ["echo quick fox jumps over fox", ["quick"]],
                    ["echo quick fox jumps over quick dog", ["dog"]],
                    ["echo quick fox jumps over quick fox", undefined],
                ]],
                ["rm ** (*) :! rm * (*) :! rm * * (*)", [
                    ["rm same same same", undefined],
                    ["rm same f1 same f2", ["f2"]],
                    ["rm f1 same f2 same", ["f1"]],
                    ["rm same same f1 f2", ["f2"]],
                    ["rm same f1 f2 same", ["same"]],
                    ["rm f1 same same", ["f1"]],
                    ["rm f1 same same f2", ["f1", "f2"]],
                ]],

                ["sort ** (*) :! sort -o=(*)", [  // check non-output paths
                    ["sort dst", ["dst"]],
                    ["sort -o dst dst", undefined],
                    ["sort -o f3 f1 f2 f3", ["f1", "f2"]],
                ]],
                ["sort * ** (*) :! sort -o=(*)", [  // check non-output paths starting from second
                    ["sort dst", undefined],
                    ["sort -o dst dst", undefined],
                    ["sort -o f3 f1 f2 f3 f4", ["f2", "f4"]],
                    ["sort f1 f2 f3 f4 -o f3", ["f2", "f4"]],
                ]],

                ["grep -f=(*) :! grep * ** (*)", [
                    ["grep -f f1 -f f4 pattern f1 f2 f3", ["f4"]],
                    ["grep -f f1 -f f2 pattern f1 f2 f3", undefined],
                    ["grep -f x pattern x y", undefined],
                    ["grep -f same -f same pattern same", undefined],
                ]],
                ["grep --include=(*) :! grep -f=(*)", [
                    ["grep --include f1 --include f2 -f f1 pattern path", ["f2"]],
                    ["grep --include f1 --include f2 pattern path", ["f1", "f2"]],
                    ["grep --include f1 --include f2 -f f1 -f f2 pattern path", undefined],
                    ["grep -f x pattern x y", undefined],
                    ["grep --include same --include same -f same pattern path", undefined],
                ]],
                ["grep --include=(*) :! grep -f=(*) * ** $1", [
                    ["grep --include f1 --include f2 -f f1 pattern f1 f2", ["f2"]],
                    ["grep --include f1 --include f2 pattern f1 f2", ["f1", "f2"]],
                    ["grep --include f1 --include f2 -f f1 -f f2 pattern f1 f2", undefined],
                    ["grep --include same --include same -f same pattern other", ["same"]],
                    ["grep --include same --include same -f same pattern same", undefined],
                ]],

                ["rm ** (*) :! rm ** (ultra/*)", [  // exclude paths in "ultra"
                    ["rm hello ultra/world", ["hello"]],
                    ["rm ultra/hello ultra/world", undefined],
                    ["rm quick ultra/fox jumps over fox", ["quick", "jumps", "over", "fox"]],
                    ["rm quick fox jumps over ultra/quick dog", ["quick", "fox", "jumps", "over", "dog"]],
                ]],
                ["rm ** (*) :! rm ** ultra/(*)", [  // exclude paths same as in "ultra"
                    ["rm hello ultra/world", ["hello", "ultra/world"]],
                    ["rm ultra/hello ultra/world", ["ultra/hello", "ultra/world"]],
                    ["rm quick ultra/fox jumps over fox", ["quick", "ultra/fox", "jumps", "over"]],
                    ["rm quick fox jumps over ultra/quick dog", ["fox", "jumps", "over", "ultra/quick", "dog"]],
                ]],
                ["rm ** (*) :! rm ** (ultra/*) :! rm ** ultra/(*)", [  // exclude both
                    ["rm quick ultra/fox jumps over fox", ["quick", "jumps", "over"]],
                    ["rm quick fox jumps over ultra/quick dog", ["fox", "jumps", "over", "dog"]],
                ]],
                ["rm ** ultra/(*) :! rm ** (*)", [
                    ["rm ultra/fox ultra/jumps ultra/over fox", ["jumps", "over"]],
                    ["rm ultra/ultra/fox jumps over ultra/fox", ["fox"]],
                ]],

                ["dd ** of=(*) :! dd ** if=(*)", [  // if not an overwrite
                    ["dd of=output", ["output"]],
                    ["dd count=42 if=output of=output", undefined],
                    ["dd count=42 if=input of=output", ["output"]],
                    ["dd of=some of=ignore if=ignore", ["some"]],
                ]],
                ["dd ** of=(*) :! dd ** of=(/tmp/*)", [
                    ["dd of=output", ["output"]],
                    ["dd of=/tmp/output", undefined],
                ]],

                ["grep * ** (*) :! grep --exclude=ignore/(*)", [
                    ["grep pat some secret other --exclude=ignore/secret", ["some", "other"]],
                    ["grep pat secret some secret --exclude=ignore/secret", ["some"]],
                    ["grep pat some other --exclude=ignore/secret", ["some", "other"]],
                    ["grep pat secret --exclude=ignore/secret", undefined],
                    ["grep pat secret secret --exclude=ignore/secret", undefined],
                ]],
                ["sort -o=sub/(*) :! sort --files0-from=(*)", [
                    ["sort -o sub/some", ["some"]],
                    ["sort -o sub/same --files0-from=same", undefined],
                    ["sort -o sub/some --files0-from=other", ["some"]],
                    ["sort -o sub/same -o sub/other --files0-from=same", ["other"]],
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
            ["cat ** f(*)", [
                ["cat", undefined],
                ["cat f1", ["1"]],
                ["cat f1 f2 f3", ["1", "2", "3"]],
            ]],
            ["sort -o #[-o=]", [
                ["sort", undefined],
                ["sort f1", undefined],
                ["sort -o f1", undefined],
                ["sort -o -- f1", ["f1"]],
                ["sort f1 f2 -o f3", ["f1", "f2"]],
            ]],
            ["cat -- header", [
                ["cat header f1 f2 f3", ["f1", "f2", "f3"]],
                ["cat header f1", ["f1"]],
                ["cat header", undefined],
                ["cat header --", undefined],
                ["cat header -- f", ["f"]],
                ["cat -- header --", ["--"]],
                ["cat -- header -- f", ["--", "f"]],
            ]],
            ["rm :! rm --dry-run", [
                ["rm", undefined],
                ["rm f1", ["f1"]],
                ["rm f1 f2 f3", ["f1", "f2", "f3"]],
                ["rm --dry-run f1", undefined],
                ["rm --dry-run f1 f2 f3", undefined],
            ]],
            ["grep * :! grep --exclude=(*) :! grep * ** (/tmp/*)", [
                ["grep a-z", undefined],
                ["grep a-z a", ["a"]],
                ["grep a-z a b c d", ["a", "b", "c", "d"]],
                ["grep a-z --exclude=b a b c d", ["a", "c", "d"]],
                ["grep a-z a b /tmp/c d", ["a", "b", "d"]],
            ]],
            ["rm ;", [
                ["rm", []],
                ["rm f1", undefined],
                ["rm f1 f2", undefined],
                ["rm f1 f2 f3", undefined],
            ]],
        ])("%s", (pattern, cases) => {
            const matcher = makeToolMatcher(pattern, true)
            for (const [cmdLine, expectedMatches] of cases) {
                const cmd = sequenceScript(cmdLine)[0]
                expect(matcher(cmd), cmdLine).toStrictEqual(expectedMatches)
            }
        })
    })

    describe("malformed", () => {
        test.each<[string, [string, undefined|string[]][]]>([
            ["echo (literal)", [
                ["echo \\(literal\\)", []],
                ["echo literal", undefined],
                ["echo \\(literal", undefined],
                ["echo literal\\)", undefined],
                ["echo", undefined],
            ]],
            ["echo ()", [
                ["echo \\(\\)", []],
                ["echo \"\"", undefined],
                ["echo", undefined],
                ["echo x", undefined],
            ]],
            ["echo )*(", [
                ["echo \\)x\\(", []],
                ["echo x", undefined],
                ["echo \\)x", undefined],
                ["echo x\\(", undefined],
                ["echo", undefined],
            ]],
            ["echo (*", [
                ["echo \\(x", []],
                ["echo x", undefined],
                ["echo", undefined],
            ]],
            ["echo )(*)", [
                ["echo \\)x", ["x"]],
                ["echo \\)\\(x\\)", ["(x)"]],
                ["echo \\)", [""]],
                ["echo x", undefined],
                ["echo", undefined],
            ]],
            ["echo a ; b", [
                ["echo a \\; b", []],
                ["echo a \\; b c d", []],
                ["echo a", undefined],
                ["echo a b", undefined],
                ["echo", undefined],
            ]],
            ["echo a;b", [
                ["echo a\\;b", []],
                ["echo a\\;b c d", []],
                ["echo a", undefined],
                ["echo a b", undefined],
                ["echo", undefined],
            ]],
            ["echo; a", [
                ["echo\\; a", []],
                ["echo\\; a b c", []],
                ["echo\\; -v a", []],
                ["echo a", undefined],
                ["echo", undefined],
                ["echo\\;", undefined],
            ]],
            ["echo; a;", [
                ["echo\\; a", []],
                ["echo\\; -v a", []],
                ["echo a", undefined],
                ["echo", undefined],
                ["echo\\; a b", undefined],
                ["echo\\;", undefined],
            ]],
            ["echo ** $1 (*)", [
                ["echo", undefined],
                ["echo a", undefined],
                ["echo a a", undefined],
                ["echo a b b c", undefined],
                ["echo a b c", undefined],
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