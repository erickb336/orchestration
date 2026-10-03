#!/usr/bin/env node
// The Node fixture's CLI (unit E2): a duration in milliseconds, with "ms" from the prepare phase. It tells whether its
// output is a terminal, so the recording shows it ran in one.
const ms = require("ms");

const input = process.argv[2] ?? "1d";
console.log(`${input} is ${ms(input)} ms (stdout is ${process.stdout.isTTY ? "a terminal" : "not a terminal"}, ${process.stdout.columns ?? "?"} columns)`);
