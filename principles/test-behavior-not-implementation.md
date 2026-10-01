---
id: test-behavior-not-implementation
name: Test behaviour, not implementation
applyWhen: writing, changing or keeping a test.
source: pstack principle-test-behavior-not-implementation, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

A test calls the code the way its users do and compares what they observe with a literal expected value. A test that asserts which calls the code made, or restates a constant the code contains, does neither.

**The check.** Before you keep a test, ask whether it would still pass if every function it imports returned `undefined`. If yes, it cannot fail for a defect. Rewrite the assertion or delete the test.

**Shapes that pass anyway:** a weak or missing assertion (`toBeDefined`, `not.toThrow`); only a mock or an absence (`toHaveBeenCalled`, `toEqual([])`); an expected value taken from the code under test; a constant pin that restates a default or a prompt string; a fixture asserting itself.

**The fix.** Call the subject with one concrete input and assert the literal output or the observable effect. For an absence, assert the presence on another input too. For a constant, test the mechanism that reads it. For a mock, assert the payload or the state after the call.

**Keep** tests of a relation across a table's rows (a key in two tables) and compile-time type tests.
