# Mock route: address validate (Issue #32)

Standalone mock POST route handler validating Stellar public key address format.

## Rules

- Must be a string
- Must start with `G`
- Length must be 56 characters

## Run

```sh
node route.mjs
```

## Example

```
POST /address-validate
{ "address": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B" }
```
