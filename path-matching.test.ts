import { expect, test, describe } from "bun:test"
import { makeMatcher, normalize } from "./path-matching"

// MARK: normalize
describe("normalize", () => {
    function normalizeTest(pattern: string): [string, number, boolean] {
        const normalForm = normalize(pattern)
        return [normalForm.segments.join("/"), normalForm.relativePrefixLen, normalForm.onlyDir]
    }

    describe("segments", () => {
        test.each<[string, [string, number, boolean]]>([
            ["x//y//z", ["x/y/z", 0, false]],
            ["/abso/lute", ["/abso/lute", 0, false]],
            ["/", ["", 0, true]],
            ["x", ["x", 0, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("universal", () => {
        test.each<[string, [string, number, boolean]]>([
            ["", ["*", 0, false]],
            ["**", ["*", 0, false]],
            ["**/**", ["*", 0, false]],
            ["**/*", ["*", 0, false]],
            ["/**", ["*", 0, false]],
            ["**/", ["*", 0, true]],
            ["**/*/", ["*", 0, true]],
            ["/**/", ["*", 0, true]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("/**", () => {
        test.each<[string, [string, number, boolean]]>([
            ["x/**/**/**", ["x/**", 0, false]],
            ["x/**/*/**/*", ["x/**/*/**/*", 0, false]],
            ["*/**", ["*/**", 0, false]],
            ["x/**/**/**/", ["x/**", 0, true]],
            ["x/**/..", ["x/**", 0, false]],
            ["x/*/..", ["x", 0, false]],
            ["x/**/*/..", ["x/**", 0, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("leading **/", () => {
        test.each<[string, [string, number, boolean]]>([
            ["**/**/x", ["x", 0, false]],
            ["**/**/x/", ["x", 0, true]],
            ["**/**/", ["*", 0, true]],
            ["**/../../x", ["x", 0, false]],
            ["**/../../", ["*", 0, true]],
            ["**/.git", [".git", 0, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("./..", () => {
        test.each<[string, [string, number, boolean]]>([
            [".", [".", 1, false]],
            ["./", [".", 1, true]],
            ["..", ["..", 1, false]],
            ["../", ["..", 1, true]],
            ["x/y/../z", ["x/z", 0, false]],
            ["x/..", ["*", 0, false]],
            ["x/../", ["*", 0, true]],
            ["x/../../z", ["z", 0, false]],
            ["/x/../../z", ["/z", 0, false]],
            ["/..", ["", 0, true]],
            ["/../", ["", 0, true]],
            ["./x/../../../z", ["../../z", 2, false]],
            ["../x/../../z", ["../../z", 2, false]],
            ["x/./y/.", ["x/y", 0, false]],
            ["./x/./y", ["./x/y", 1, false]],
            ["..//x", ["../x", 1, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("~", () => {
        test.each<[string, [string, number, boolean]]>([
            ["~", ["~", 1, false]],
            ["~/", ["~", 1, true]],
            ["~/x", ["~/x", 1, false]],
            ["~/../x", ["~/../x", 2, false]],
            ["~/../x/../..", ["~/../..", 3, false]],
            ["x/~/../y", ["x/y", 0, false]],
            ["x/../~", ["~", 0, false]],
            ["x/../~/../y", ["y", 0, false]],
            ["../~/x", ["../~/x", 1, false]],
            ["./~/x", ["./~/x", 1, false]],
            ["**/~", ["~", 0, false]],
            ["x/**/~", ["x/**/~", 0, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })

    describe("other", () => {
        test.each<[string, [string, number, boolean]]>([
            ["../../x/**/y/z/../../../a", ["../../x/**/a", 2, false]],
        ])("%p", (pattern, expected) => {
            expect(normalizeTest(pattern)).toStrictEqual(expected)
        })
    })
})

// MARK: /path/segments
describe("path segments", () => {
    test("simplest match", () => {
        const matcher = makeMatcher("test")("/home")("/proj")
        expect(matcher("test", undefined)).toBe(true)
        expect(matcher("test/", undefined)).toBe(true)
        expect(matcher("/test", undefined)).toBe(true)
        expect(matcher("testt", undefined)).toBe(false)
        expect(matcher("ttest", undefined)).toBe(false)
        expect(matcher("tes", undefined)).toBe(false)
        expect(matcher("est", undefined)).toBe(false)
    })

    test("only full segments", () => {
        const matcher = makeMatcher("src/config")("/home")("/proj")
        expect(matcher("src/config", undefined)).toBe(true)
        expect(matcher("src/config/", undefined)).toBe(true)
        expect(matcher("/src/config", undefined)).toBe(true)
        expect(matcher("/src/config/", undefined)).toBe(true)
        expect(matcher("other_src/config", undefined)).toBe(false)
        expect(matcher("src_other/config", undefined)).toBe(false)
        expect(matcher("src/config_other", undefined)).toBe(false)
        expect(matcher("src/other_config", undefined)).toBe(false)
        expect(matcher("src/conf", undefined)).toBe(false)
    })

    test("absolute pattern matches only absolute paths", () => {
        const matcher = makeMatcher("/proj/src/config")("/home")("/proj")
        expect(matcher("/proj/src/config", undefined)).toBe(true)
        expect(matcher("src/config", undefined)).toBe(false)
        expect(matcher("/src/config", undefined)).toBe(false)
        expect(matcher("proj/src/config", undefined)).toBe(false)
    })

    test("relative pattern matches children of anything", () => {
        const matcher = makeMatcher("src/config")("/home")("/proj")
        expect(matcher("src/config", undefined)).toBe(true)
        expect(matcher("/src/config", undefined)).toBe(true)
        expect(matcher("/proj/src/config", undefined)).toBe(true)
        expect(matcher("test/src/config", undefined)).toBe(true)
        expect(matcher("/test/src/config", undefined)).toBe(true)
        expect(matcher("test/config", undefined)).toBe(false)
    })

    test("no trailing / -> doesn't match children", () => {
        const matcher = makeMatcher("src/config")("/home")("/proj")
        expect(matcher("src/config", undefined)).toBe(true)
        expect(matcher("src/config/", undefined)).toBe(true)
        expect(matcher("src/config/nested", undefined)).toBe(false)
    })

    test("trailing / -> doesn't match children", () => {
        const matcher = makeMatcher("src/")("/home")("/proj")
        expect(matcher("src", undefined)).toBe(true)
        expect(matcher("src/", undefined)).toBe(true)
        expect(matcher("src/nested", undefined)).toBe(false)
        expect(matcher("src/nested/", undefined)).toBe(false)
        expect(matcher("test", undefined)).toBe(false)
        expect(matcher("test/src", undefined)).toBe(true)
        expect(matcher("test/src/nested", undefined)).toBe(false)
    })
})

describe("wildcards", () => {

    // MARK: *-star
    describe("* matches only within path segment", () => {
        test("* for part of segment", () => {
            const matcher = makeMatcher("src/test*.ts")("/home")("/proj")
            expect(matcher("src/test-file.ts", undefined)).toBe(true)
            expect(matcher("src/test-other.ts", undefined)).toBe(true)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("src/test/file.ts", undefined)).toBe(false)
            expect(matcher("src/other-test.ts", undefined)).toBe(false)
            expect(matcher("src/nested/test-file.ts", undefined)).toBe(false)
        })

        test("* also matches empty part of name", () => {
            let matcher = makeMatcher("*.ts")("/home")("/proj")
            expect(matcher(".ts", undefined)).toBe(true)
            expect(matcher("src/.ts", undefined)).toBe(true)
            expect(matcher(".js", undefined)).toBe(false)
        })

        test("/*/ requires exactly one segment", () => {
            const middle = makeMatcher("src/*/test.ts")("/home")("/proj")
            expect(middle("src/test.ts", undefined)).toBe(false)
            expect(middle("src/nested/test.ts", undefined)).toBe(true)
            expect(middle("src/deeply/nested/test.ts", undefined)).toBe(false)
            expect(middle("src/nested/other.ts", undefined)).toBe(false)

            const trailing = makeMatcher("src/*")("/home")("/proj")
            expect(trailing("src", undefined)).toBe(false)
            expect(trailing("src/", undefined)).toBe(false)
            expect(trailing("src/test.ts", undefined)).toBe(true)
        })

        test("trailing /* matches only immediate children", () => {
            const matcher = makeMatcher("src/*")("/home")("/proj")
            expect(matcher("src/nested", undefined)).toBe(true)
            expect(matcher("src/nested/", undefined)).toBe(true)
            expect(matcher("src/nested/test.ts", undefined)).toBe(false)
            expect(matcher("src", undefined)).toBe(false)
        })

        test("singleton * matches everything", () => {
            const matcher = makeMatcher("*")("/home")("/proj")
            expect(matcher("file.ts", undefined)).toBe(true)
            expect(matcher("src", undefined)).toBe(true)
            expect(matcher("src/", undefined)).toBe(true)
            expect(matcher("any/path/to/file.ts", undefined)).toBe(true)
        })
    })

    // MARK: **-globstar
    describe("** matches through path separators", () => {
        test("middle `/**/` is zero or more", () => {
            const matcher = makeMatcher("src/**/test.ts")("/home")("/proj")
            expect(matcher("src/a/b/c/test.ts", undefined)).toBe(true)
            expect(matcher("src/components/test.ts", undefined)).toBe(true)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("src/othertest.ts", undefined)).toBe(false)
            expect(matcher("other/a/b/c/test.ts", undefined)).toBe(false)
        })

        test("leading **/ does nothing", () => {
            const matcher = makeMatcher("**/test.ts")("/home")("/proj")
            expect(matcher("src/a/b/c/test.ts", undefined)).toBe(true)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("test.ts", undefined)).toBe(true)
            expect(matcher("/test.ts", undefined)).toBe(true)
            expect(matcher("other.ts", undefined)).toBe(false)
            expect(matcher("test.ts/other.ts", undefined)).toBe(false)
        })

        test.each(
            ["/**", "/**/", "/**/**"]
        )("trailing x%s matches both parent and children", pattern => {
            const matcher = makeMatcher("src" + pattern)("/home")("/proj")
            expect(matcher("src", undefined)).toBe(true)
            expect(matcher("src/", undefined)).toBe(true)
            expect(matcher("src/a/b/c/test.ts", undefined)).toBe(true)
            expect(matcher("src/components/test.ts", undefined)).toBe(true)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("srcccc", undefined)).toBe(false)
        })

        test("trailing x/**/* matches only children", () => {
            const matcher = makeMatcher("src/**/*")("/home")("/proj")
            expect(matcher("src", undefined)).toBe(false)
            expect(matcher("src/", undefined)).toBe(false)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("src/deeply/nested/test.ts", undefined)).toBe(true)
            expect(matcher("other/test.ts", undefined)).toBe(false)
        })

        test("trailing /**/*/**/* matches at least 2 segment long paths", () => {
            const matcher = makeMatcher("/**/*/**/*")("/home")("/proj")
            expect(matcher("src", undefined)).toBe(false)
            expect(matcher("src/", undefined)).toBe(false)
            expect(matcher("src/test.ts", undefined)).toBe(true)
            expect(matcher("src/deeply/nested/test.ts", undefined)).toBe(true)
        })
    })

    // MARK: other wildcards

    test("? matches exactly one character", () => {
        const matcher = makeMatcher("src/?/test-?.ts")("/home")("/proj")
        expect(matcher("src/x/test-a.ts", undefined)).toBe(true)
        expect(matcher("src/n/test-b.ts", undefined)).toBe(true)
        expect(matcher("src/n/test-bb.ts", undefined)).toBe(false)
        expect(matcher("src/nn/test-b.ts", undefined)).toBe(false)
        expect(matcher("src/n/test-.ts", undefined)).toBe(false)
        expect(matcher("src/test-b.ts", undefined)).toBe(false)
    })

    test("mix of multiple wildcards", () => {
        const matcher = makeMatcher("src/**/a/*/b/**/c/*.ts")("/home")("/proj")
        expect(matcher("src/x/a/y/b/z/c/test.ts", undefined)).toBe(true)
        expect(matcher("src/x/xx/a/y/b/z/zz/c/test.ts", undefined)).toBe(true)
        expect(matcher("src/a/y/b/c/test.ts", undefined)).toBe(true)
        expect(matcher("src/a/b/b/c/test.ts", undefined)).toBe(true)
        expect(matcher("src/x/a/b/c/z/test.ts", undefined)).toBe(false)
        expect(matcher("src/a/b/c/test.ts", undefined)).toBe(false)
        expect(matcher("src/test.ts", undefined)).toBe(false)
    })
})

// MARK: :!-exceptions
describe("exceptions", () => {
    test("main pattern matches, while exceptions don't", () => {
        const matcher = makeMatcher("src/*:!src/*.md")("/home")("/proj")
        expect(matcher("src/file.ts", undefined)).toBe(true)
        expect(matcher("src/file.md", undefined)).toBe(false)
    })

    test("no main pattern", () => {
        const matcher = makeMatcher(":!src/*.md")("/home")("/proj")
        expect(matcher("src/file.md", undefined)).toBe(false)
        expect(matcher("src/file.ts", undefined)).toBe(true)
        expect(matcher("src", undefined)).toBe(true)
        expect(matcher("other", undefined)).toBe(true)
    })

    test("multiple exceptions", () => {
        const matcher = makeMatcher("*.ts:!test.ts:!*.spec.ts")("/home")("/proj")
        expect(matcher("file.ts", undefined)).toBe(true)
        expect(matcher("helper.ts", undefined)).toBe(true)
        expect(matcher("test.ts", undefined)).toBe(false)
        expect(matcher("file.spec.ts", undefined)).toBe(false)
    })
})

// MARK: directory check
describe("directory check", () => {
    test("no trailing / -> matches either a file or directory", () => {
        const matcher = makeMatcher("src/config")("/home")("/proj")
        expect(matcher("src/config", false)).toBe(true)
        expect(matcher("src/config/", false)).toBe(true)
        expect(matcher("src/config", true)).toBe(true)
        expect(matcher("src/config/", true)).toBe(true)
        expect(matcher("src/config", undefined)).toBe(true)
        expect(matcher("src/nested/config", false)).toBe(false)
    })

    test("trailing / -> matches only a potential directory", () => {
        const matcher = makeMatcher("src/")("/home")("/proj")
        expect(matcher("src", false)).toBe(false)
        expect(matcher("src/", false)).toBe(false)
        expect(matcher("src", true)).toBe(true)
        expect(matcher("src/", true)).toBe(true)
        expect(matcher("src", undefined)).toBe(true)
        expect(matcher("src/", undefined)).toBe(true)
    })

    test("trailing /* -> matches both files and directories", () => {
        const matcher = makeMatcher("src/*")("/home")("/proj")
        expect(matcher("src/dir", true)).toBe(true)
        expect(matcher("src/file", false)).toBe(true)
        expect(matcher("src/something", undefined)).toBe(true)
        expect(matcher("src/nested/dir", true)).toBe(false)
        expect(matcher("src/nested/file", false)).toBe(false)
        expect(matcher("src/nested/something", undefined)).toBe(false)
    })

    test("partial x* -> matches both files and directories", () => {
        const matcher = makeMatcher("src/file*")("/home")("/proj")
        expect(matcher("src/file", false)).toBe(true)
        expect(matcher("src/file", true)).toBe(true)
        expect(matcher("src/file", undefined)).toBe(true)
        expect(matcher("src/file1", false)).toBe(true)
        expect(matcher("src/files", true)).toBe(true)
        expect(matcher("src/file?", undefined)).toBe(true)
        expect(matcher("src/nested/file", false)).toBe(false)
    })

    test("trailing */ -> matches only potential directories", () => {
        const matcher = makeMatcher("src/*/")("/home")("/proj")
        expect(matcher("src/dir", true)).toBe(true)
        expect(matcher("src/dir/", true)).toBe(true)
        expect(matcher("src/file", false)).toBe(false)
        expect(matcher("src/file/", false)).toBe(false)
        expect(matcher("src/something", undefined)).toBe(true)
        expect(matcher("src/something/", undefined)).toBe(true)
        expect(matcher("src/nested/dir", true)).toBe(false)
        expect(matcher("src/nested/file", false)).toBe(false)
        expect(matcher("src/nested/something", undefined)).toBe(false)
    })

    test.each(
        ["/**", "/**/**"]
    )("trailing %s -> matches both files and directories", pattern => {
        const matcher = makeMatcher("src" + pattern)("/home")("/proj")
        expect(matcher("src/dir", true)).toBe(true)
        expect(matcher("src/file", false)).toBe(true)
        expect(matcher("src/something", undefined)).toBe(true)
        expect(matcher("src/nested/dir", true)).toBe(true)
        expect(matcher("src/nested/file", false)).toBe(true)
        expect(matcher("src/nested/something", undefined)).toBe(true)
    })

    test.each(
        ["/**/", "/**/**/"]
    )("trailing %s -> matches only potential directories", pattern => {
        const matcher = makeMatcher("src" + pattern)("/home")("/proj")
        expect(matcher("src", true)).toBe(true)
        expect(matcher("src", false)).toBe(false)
        expect(matcher("src", undefined)).toBe(true)
        expect(matcher("src/dir", true)).toBe(true)
        expect(matcher("src/dir/", true)).toBe(true)
        expect(matcher("src/file", false)).toBe(false)
        expect(matcher("src/file/", false)).toBe(false)
        expect(matcher("src/something", undefined)).toBe(true)
        expect(matcher("src/something/", undefined)).toBe(true)
        expect(matcher("src/nested/dir", true)).toBe(true)
        expect(matcher("src/nested/file", false)).toBe(false)
        expect(matcher("src/nested/file/", false)).toBe(false)
    })

    test.each(
        ["/**", "/**/", "/**/**"]
    )("trailing %s -> matches parent only if it's a potential directory", pattern => {
        const matcher = makeMatcher("src" + pattern)("/home")("/proj")
        expect(matcher("src", true)).toBe(true)
        expect(matcher("src/", true)).toBe(true)
        expect(matcher("src", false)).toBe(false)
        expect(matcher("src/", false)).toBe(false)
        expect(matcher("src", undefined)).toBe(true)
        expect(matcher("src/", undefined)).toBe(true)
    })

    test("*:!*/ -> matches only paths known to be files", () => {
        const matcher = makeMatcher("*:!*/")("/home")("/proj")
        expect(matcher("src/file", false)).toBe(true)
        expect(matcher("src/dir", true)).toBe(false)
        expect(matcher("src/nonexistent", undefined)).toBe(false)
        expect(matcher("file", false)).toBe(true)
        expect(matcher("dir", true)).toBe(false)
        expect(matcher("nonexistent", undefined)).toBe(false)
    })

    test("with exception for parent of unknown type -> doesn't match parent", () => {
        const matcher = makeMatcher("*:!unknown/**")("/home")("/proj")
        expect(matcher("unknown", undefined)).toBe(false)
        expect(matcher("unknown/nested", undefined)).toBe(false)
        expect(matcher("test", undefined)).toBe(true)
    })
})

// MARK: ../.-cwd
describe("cwd", () => {
    test("leading . -> cwd-relative, matches only paths within cwd", () => {
        const matcher = makeMatcher("./src/config")("/home")
        expect(matcher("/proj")("/proj/src/config", undefined)).toBe(true)
        expect(matcher("/other")("/proj/src/config", undefined)).toBe(false)
        expect(matcher("/proj")("src/config", undefined)).toBe(false)
        expect(matcher("/proj")("test/src/config", undefined)).toBe(false)
        expect(matcher("/proj")("/projsrc/config", undefined)).toBe(false)
    })

    test("leading .. -> cwd-relative, matches only some paths outside cwd", () => {
        const matcher = makeMatcher("../src/config")("/home")
        expect(matcher("/proj")("/src/config", undefined)).toBe(true)
        expect(matcher("/proj/nested")("/proj/src/config", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/config", undefined)).toBe(false)
        expect(matcher("/proj")("src/config", undefined)).toBe(false)
        expect(matcher("/proj/nested")("/src/config", undefined)).toBe(false)
        expect(matcher("/proj/nested")("/projsrc/config", undefined)).toBe(false)
    })

    test("multiple leading .. -> matches only some paths outside cwd", () => {
        const matcher = makeMatcher("../../src/config")("/home")
        expect(matcher("/proj/deeply/nested")("/proj/src/config", undefined)).toBe(true)
        expect(matcher("/proj/nested")("/src/config", undefined)).toBe(true)
        expect(matcher("/proj")("/src/config", undefined)).toBe(false)
        expect(matcher("/proj")("/proj/src/config", undefined)).toBe(false)
        expect(matcher("/proj")("src/config", undefined)).toBe(false)
    })

    test("only non-leading . or .. -> normalized, matches anywhere outside cwd", () => {
        const matcher = makeMatcher("src/./config/../file")("/home")
        expect(matcher("/proj")("src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/any/where/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("src/config/file", undefined)).toBe(false)
        expect(matcher("/proj")("/proj/src/config/file", undefined)).toBe(false)
    })

    test("mixed leading with non-leading -> matches only relative to cwd", () => {
        const matcher = makeMatcher("../src/config/../file")("/home")
        expect(matcher("/proj/nested")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/src/file", undefined)).toBe(true)
        expect(matcher("/proj/nested")("src/config/file", undefined)).toBe(false)
        expect(matcher("/proj/nested")("src/file", undefined)).toBe(false)
        expect(matcher("/proj/nested")("/proj/src/config/file", undefined)).toBe(false)
        expect(matcher("/proj")("/any/where/src/file", undefined)).toBe(false)
    })

    test("excessive .. -> collapses prefix, matches anywhere", () => {
        const matcher = makeMatcher("src/../../file")("/home")
        expect(matcher("/proj")("file", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/any/where/file", undefined)).toBe(true)
        expect(matcher("/proj")("src", undefined)).toBe(false)
        expect(matcher("/proj")("file/src", undefined)).toBe(false)
    })

    test("cwd-relative with excessive .. -> collapses prefix, but stays cwd-relative", () => {
        const matcher = makeMatcher("./src/../../../file")("/home")
        expect(matcher("/proj/nested")("/file", undefined)).toBe(true)
        expect(matcher("/proj/nested")("file", undefined)).toBe(false)
        expect(matcher("/proj")("/file", undefined)).toBe(false)
    })

    test("./** -> matches anything within cwd", () => {
        const matcher = makeMatcher("./**")("/home")
        expect(matcher("/proj")("/proj", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/any/where/else", undefined)).toBe(false)
        expect(matcher("/proj")("file", undefined)).toBe(false)
    })

    test("/* gets consumed by ..", () => {
        const matcher = makeMatcher("src/*/..")("/home")
        expect(matcher("/proj")("/proj", undefined)).toBe(false)
        expect(matcher("/proj")("/proj/src", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(false)
    })

    test("/** consumes ..", () => {
        const matcher = makeMatcher("src/**/..")("/home")
        expect(matcher("/proj")("/proj", undefined)).toBe(false)
        expect(matcher("/proj")("/proj/src", undefined)).toBe(true)
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/any/where/else", undefined)).toBe(false)
        expect(matcher("/proj")("src/file", undefined)).toBe(true)
    })

    test("no-op **/ consumes ..", () => {
        const matcher = makeMatcher("**/..")("/home")
        expect(matcher("/proj")("/proj/src/file", undefined)).toBe(true)
        expect(matcher("/proj")("/any/where", undefined)).toBe(true)
        expect(matcher("/proj")("anything", undefined)).toBe(true)
    })

    test(".. preserves dir-check", () => {
        const matcher = makeMatcher("src/config/../")("/home")
        expect(matcher("/proj")("src", false)).toBe(false)
        expect(matcher("/proj")("src", true)).toBe(true)
    })
})

// MARK: ~-home
describe("home", () => {
    test("leading ~ -> home-relative, matches only paths within home", () => {
        const matcher = makeMatcher("~/src/config")("/home")("/proj")
        expect(matcher("/home/src/config", undefined)).toBe(true)
        expect(matcher("/homesrc/config", undefined)).toBe(false)
        expect(matcher("/proj/src/config", undefined)).toBe(false)
        expect(matcher("/src/config", undefined)).toBe(false)
        expect(matcher("src/config", undefined)).toBe(false)
        expect(matcher("~/src/config", undefined)).toBe(false)
    })

    test("non-leading ~ -> just a segment name", () => {
        const matcher = makeMatcher("src/~/nested/~some/file")("/home")("/proj")
        expect(matcher("src/~/nested/~some/file", undefined)).toBe(true)
        expect(matcher("/home/src/~/nested/~some/file", undefined)).toBe(true)
        expect(matcher("/proj/src/~/nested/~some/file", undefined)).toBe(true)
        expect(matcher("/any/where/src/~/nested/~some/file", undefined)).toBe(true)
        expect(matcher("src/x/nested/~some/file", undefined)).toBe(false)
        expect(matcher("src/nested/~some/file", undefined)).toBe(false)
        expect(matcher("src/~/nested/xsome/file", undefined)).toBe(false)
        expect(matcher("src/~/nested/some/file", undefined)).toBe(false)
    })

    test("~/** -> matches anything within home only", () => {
        const matcher = makeMatcher("~/**")("/home")("/proj")
        expect(matcher("/home", undefined)).toBe(true)
        expect(matcher("/home/file", undefined)).toBe(true)
        expect(matcher("/home/nested/file", undefined)).toBe(true)
        expect(matcher("/proj/file", undefined)).toBe(false)
        expect(matcher("/file", undefined)).toBe(false)
    })

    test("**/~ -> just a segment name", () => {
        const matcher = makeMatcher("**/~")("/home")("/proj")
        expect(matcher("~", undefined)).toBe(true)
        expect(matcher("nested/~", undefined)).toBe(true)
        expect(matcher("/home", undefined)).toBe(false)
        expect(matcher("something/home", undefined)).toBe(false)
    })

    test("leading ~/.. -> home-relative, matches only some home-relative paths", () => {
        const matcher = makeMatcher("~/../morty/config")("/users/rick")("/proj")
        expect(matcher("/users/morty/config", undefined)).toBe(true)
        expect(matcher("/users/rick/config", undefined)).toBe(false)
        expect(matcher("/users/rick/morty/config", undefined)).toBe(false)
        expect(matcher("/users/jerry/config", undefined)).toBe(false)
    })

    test("non-leading ~/.. -> normalized, matches anywhere", () => {
        const matcher = makeMatcher("src/~/../config")("/home")("/proj")
        expect(matcher("src/config", undefined)).toBe(true)
        expect(matcher("/src/home/config", undefined)).toBe(false)
        expect(matcher("/home/config", undefined)).toBe(false)
        expect(matcher("/config", undefined)).toBe(false)
    })

    test("home is root", () => {
        const matcher = makeMatcher("~/path")("/")("/proj")
        expect(matcher("/path", undefined)).toBe(true)
        expect(matcher("path", undefined)).toBe(false)
        expect(matcher("~/path", undefined)).toBe(false)
        expect(matcher("/proj/path", undefined)).toBe(false)
    })
})