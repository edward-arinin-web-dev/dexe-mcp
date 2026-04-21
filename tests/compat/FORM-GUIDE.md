# DeXe DAO Creation Form Reference

> Target: `localhost:3000` (DeXe frontend)
> Purpose: Automated form-filling via Chrome DevTools MCP

---

## Steps & Navigation

### Step 0: "Before you start"
- Click **"Start"** button
- UID pattern: `button "Start"`

### Step 1: "Basic DAO Settings"
| Field | Type | Notes |
|-------|------|-------|
| DAO name | `textbox` (name="") | Standard text input |
| DAO Description | multiline `textbox` | Slate.js rich text editor |
| DAO site | `textbox` | Has `https://` prefix baked in — do NOT include protocol in value or you get `https:///` |

**Social links** (all optional): facebook, linkedin, medium, telegram, twitter, github

### Step 2: "Governance"
- BEP-20 toggle is **already on** by default
- Token address field: `textbox "Custom BEP-20 token"`
- Token is validated on-chain via RPC — must be a real BSC token
- Default tokenlist at `/lists/dexe-default.tokenlist.json`: DEXE, WBNB, BUSD, ETH, BTCB

### Step 3: "Voting parameters"
- **Voting model**: radio buttons (Linear / Meritocratic / Custom)
- **Duration picker**: custom format like `1Y 6Mon 2w 1d`
  - Type `"1d"` then click the `"1 Day(s)"` dropdown option
- **Execution delay**: same format
  - Typing raw `"0"` fails validation — must click `"0 Seconds"` dropdown option
- **Quorum**: percentage input
- **Min votes fields**:
  - Vote in proposals
  - Create proposals
  - Read proposal discussions
  - Comment on proposals

### Step 4: "Validators"
- Toggle is **off** by default
- For minimal config: just click Next

### Step 5: "Summary"
- Review all values
- **"Create DAO"** button submits

**Navigation buttons**: `button "Next"`, `button "Previous"`, `button "Create DAO"`

---

## Input Names (DOM)

| Name | Type |
|------|------|
| `duration` | time picker |
| `executionDelay` | time picker |
| `quorum` | percentage |
| `minVotesForVoting` | number |
| `minVotesForCreating` | number |
| `minVotesForReadProposalDiscussion` | number |
| `minVotesForCreatingComment` | number |
| `create-fund-is-vote-delegation-on` | checkbox (checked = delegation on) |
| `create-fund-is-early-completion-on` | checkbox |
| `create-proposal-is-rewards-enabled-on` | checkbox |
| `use-gov-token-as-rewards` | checkbox |
| `rewardToken` | token address |
| `creationReward` | number |
| `voteRewardsCoefficient` | number |
| `executionReward` | number |

---

## Form-Filling Problems & Solutions

### 1. DAO site field has `https://` prefix
Using `fill` tool appends to existing value, producing `https:///example.com`.

**Solution**: Use native value setter to set the full URL including protocol.

### 2. Duration/Execution delay pickers
Not regular text inputs. They parse time format strings and show dropdown suggestions.

**Solution**: Type the format string (e.g. `"1d"`) AND click the dropdown suggestion button (e.g. `"1 Day(s)"`). Setting raw `"0"` for execution delay fails validation — must click `"0 Seconds"` dropdown.

### 3. Quorum field append bug
Using `fill` tool appends value. Field may have existing content.

**Solution**: Always use native value setter:
```javascript
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(input, 'new value');
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

### 4. Token validation
Frontend calls RPC to validate token. Takes 1-2 seconds. Error `"Please enter valid BEP-20"` appears while validating or if token doesn't exist on current chain.

**Note**: BUSD Ethereum address won't work on BSC. Use BSC-native addresses only.

### 5. React input filling (general pattern)
Standard `fill` tool works for most fields BUT may append. For clean fills use the native setter pattern:
```javascript
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(input, 'new value');
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

### 6. Slate editor (description)
Uses Slate.js rich text editor. May throw `"Cannot resolve a Slate point from DOM point"` errors — these are **harmless, ignore them**.

### 7. Screenshot timeouts
`Page.captureScreenshot` occasionally times out after navigation/clicks. **Just retry.**

### 8. WalletConnect + no window.ethereum
MCP browser has no extensions. Wallet connected via WalletConnect QR. `window.ethereum` is **NOT available**.

**Consequence**: `interceptor.js` won't work. Capture calldata from network requests instead — look for `eth_estimateGas` or `eth_sendTransaction` POST to RPC URL with large content-length.

---

## Network Capture Strategy

After clicking "Create DAO":

1. Frontend uploads metadata to Pinata — `POST api.pinata.cloud/pinning/pinJSONToIPFS` (3-4 requests)
2. Frontend calls `eth_estimateGas` on RPC with full deploy calldata — look for POST to `mbsc1.dexe.io/rpc` with content-length >5000
3. Frontend sends tx via WalletConnect relay — shows "Waiting" modal
4. **Calldata** is in the `eth_estimateGas` request body at `params[0].data`

---

## Factory Details

| Property | Value |
|----------|-------|
| Factory address | `0x85f86ef7e72e86bdeab5f65e2b76a2c551f22109` |
| Selector | `0x0cc3c11c` (`createDaoByPoolFactory`) |
| Note | Frontend auto-generates 5 proposal settings (one per proposal type) even for minimal config |

---

## Useful Selectors/UIDs

- Snapshot UIDs change between page loads but **button text is stable**
- Search snapshots with: `grep -i "next\|start\|create dao" snapshot.txt`
- Stable button patterns:
  - `button "Start"`
  - `button "Next"`
  - `button "Previous"`
  - `button "Create DAO"`
