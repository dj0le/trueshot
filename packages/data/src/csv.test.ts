import { expect, test } from "bun:test";
import { csvToRows, parseCsv } from "./csv";

test("quoted fields keep commas, doubled quotes and newlines", () => {
  expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\n')).toEqual([
    ["a", "b,c", 'say "hi"', "two\nlines"],
  ]);
});

test("empty fields and CRLF line endings", () => {
  expect(parseCsv("1,,3\r\n4,5,\r\n")).toEqual([
    ["1", "", "3"],
    ["4", "5", ""],
  ]);
});

test("rows are keyed by header", () => {
  expect(csvToRows('ID,Name_lang\n75,"Auto Shot"\n')).toEqual([{ ID: "75", Name_lang: "Auto Shot" }]);
});
