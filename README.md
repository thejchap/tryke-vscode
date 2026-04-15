# tryke-vscode
<img width="1240" height="595" alt="Screenshot 2026-03-07 at 23 51 37" src="https://github.com/user-attachments/assets/a2d34bf0-ab80-4a39-86d7-397396127730" />

vscode extension for [tryke](https://github.com/thejchap/tryke)

## parametrized tests

`@test.cases` functions show up as one Test Explorer item per case label. Both forms are supported with full fidelity because discovery reads tryke's `--collect-only` JSON output:

```python
@test.cases(
    zero={"n": 0, "expected": 0},
    one={"n": 1, "expected": 1},
    ten={"n": 10, "expected": 100},
)
def square(n: int, expected: int) -> None:
    expect(n * n).to_equal(expected)
```

The tree shows `square[zero]`, `square[one]`, `square[ten]`. Running an individual case dispatches `tryke test … -k 'square[zero]'`, and the per-case `test_complete` events from tryke map back to the matching tree item by label suffix.

