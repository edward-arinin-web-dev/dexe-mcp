/**
 * Form Filler — Auto-fills the DeXe DAO creation form using data-testid selectors.
 *
 * This file defines helper functions that the orchestrator calls via
 * Chrome DevTools MCP's javascript_tool. Each function fills one wizard step.
 *
 * Convention: all selectors use `[data-testid="..."]` as discovered from
 * CreateDaoForm.selectors.ts in the investing-dashboard codebase.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Set an input value using React's internal fiber to trigger onChange.
 * Direct .value= assignment doesn't work with React controlled inputs.
 */
function setReactInput(selector, value) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Click an element by data-testid.
 */
function clickTestId(testId) {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`data-testid not found: ${testId}`);
  el.click();
  return true;
}

/**
 * Set input value by data-testid.
 */
function fillTestId(testId, value) {
  return setReactInput(`[data-testid="${testId}"]`, value);
}

/**
 * Check if a toggle/checkbox is in the expected state and click if needed.
 */
function ensureToggle(testId, shouldBeActive) {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`Toggle not found: ${testId}`);
  // Most toggles use aria-checked or a className with "active"
  const isActive =
    el.getAttribute('aria-checked') === 'true' ||
    el.classList.contains('active') ||
    el.querySelector('.active') !== null ||
    el.querySelector('[aria-checked="true"]') !== null;
  if (isActive !== shouldBeActive) {
    el.click();
  }
  return true;
}

/**
 * Wait for an element to appear in the DOM.
 */
function waitForTestId(testId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(`[data-testid="${testId}"]`);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${testId}`));
    }, timeoutMs);
  });
}

// ─── Step Fillers ───────────────────────────────────────────────────────────

/**
 * Fill Step 1: Basic DAO Settings
 * @param {Object} values - { name, description, website, socials: {}, documents: [] }
 */
function fillBasicSettings(values) {
  const S = {
    name: 'Create DAO (Basic DAO Settings)/DAO name input',
    description: 'Create DAO (Basic DAO Settings)/DAO description input',
    site: 'Create DAO (Basic DAO Settings)/DAO site input',
    facebook: 'Create DAO(Basic DAO Settings)/facebook link input',
    linkedin: 'Create DAO(Basic DAO Settings)/linkedin link input',
    medium: 'Create DAO(Basic DAO Settings)/medium link input',
    telegram: 'Create DAO(Basic DAO Settings)/telegram link input',
    twitter: 'Create DAO(Basic DAO Settings)/twitter link input',
    github: 'Create DAO(Basic DAO Settings)/github link input',
  };

  fillTestId(S.name, values.name);
  if (values.description) fillTestId(S.description, values.description);
  if (values.website) fillTestId(S.site, values.website);

  if (values.socials) {
    for (const [key, url] of Object.entries(values.socials)) {
      if (S[key] && url) fillTestId(S[key], url);
    }
  }

  // Documents (click "Add more", then fill name/link pairs)
  if (values.documents && values.documents.length > 0) {
    for (const doc of values.documents) {
      clickTestId('Create DAO(Basic DAO Settings)/Add more (documents) button');
      // Fill latest empty document inputs
      const nameInputs = document.querySelectorAll(`[data-testid="Create DAO(Basic DAO Settings)/Document's name input"]`);
      const linkInputs = document.querySelectorAll(`[data-testid="Create DAO(Basic DAO Settings)/Document's link input"]`);
      if (nameInputs.length > 0) {
        setReactInput(nameInputs[nameInputs.length - 1], doc.name);
        setReactInput(linkInputs[linkInputs.length - 1], doc.link);
      }
    }
  }

  return { step: 'basic-settings', filled: true };
}

/**
 * Fill Step 2: Governance
 * @param {Object} values - { tokenType, tokenAddress?, nftAddress?, nftVotingPower?, babToken? }
 * tokenType: 'bep20' | 'erc721' | 'bab' | 'create'
 */
function fillGovernance(values) {
  const S = {
    babToggle: 'Create DAO(Governance)/BAB token toggle',
    bep20Toggle: 'Create DAO(Governance)/BEP-20 token toggle',
    bep20Input: 'Create DAO(Governance)/BEP-20 token input',
    createButton: 'Create DAO(Governance)/Create (token) button',
    erc721Toggle: 'Create DAO(Governance)/ERC-721 NFTs toggle',
    nftAddress: 'Create DAO(Governance)/NFT address input',
    nftPower: 'Create DAO(Governance)/NFT voting power input',
  };

  if (values.tokenType === 'bep20') {
    clickTestId(S.bep20Toggle);
    if (values.tokenAddress) fillTestId(S.bep20Input, values.tokenAddress);
  } else if (values.tokenType === 'create') {
    clickTestId(S.createButton);
  }

  if (values.babToken) {
    clickTestId(S.babToggle);
  }

  if (values.nftAddress) {
    clickTestId(S.erc721Toggle);
    fillTestId(S.nftAddress, values.nftAddress);
    if (values.nftVotingPower) fillTestId(S.nftPower, values.nftVotingPower);
  }

  return { step: 'governance', filled: true };
}

/**
 * Fill Step 3: Create Own Token (only if governance step selected "create")
 * @param {Object} values - { name, symbol, cap?, totalSupply, initialDistribution?, treasury?, recipients: [{address, amount}] }
 */
function fillCreateToken(values) {
  const S = {
    name: 'Create DAO(Create own token)/Token name input',
    symbol: 'Create DAO(Create own token)/Token symbol input',
    cap: 'Create DAO(Create own token)/Cap input',
    totalSupply: 'Create DAO(Create own token)/Total supply input',
    initialDistribution: 'Create DAO(Create own token)/Initial Distribution input',
    treasury: 'Create DAO(Create own token)/Treasury input',
  };

  fillTestId(S.name, values.name);
  fillTestId(S.symbol, values.symbol);
  if (values.cap) fillTestId(S.cap, values.cap);
  if (values.totalSupply) fillTestId(S.totalSupply, values.totalSupply);
  if (values.initialDistribution) fillTestId(S.initialDistribution, values.initialDistribution);
  if (values.treasury) fillTestId(S.treasury, values.treasury);

  // Recipients
  if (values.recipients && values.recipients.length > 0) {
    for (let i = 0; i < values.recipients.length; i++) {
      if (i > 0) {
        clickTestId('Create DAO(Create own token)/Add Recipient button');
      }
      const recipientInputs = document.querySelectorAll(`[data-testid="Create DAO(Create own token)/Distribution recipient input"]`);
      const supplyInputs = document.querySelectorAll(`[data-testid="Create DAO(Create own token)/Disctribution recipient supply input"]`);
      if (recipientInputs[i]) {
        setReactInput(recipientInputs[i], values.recipients[i].address);
        setReactInput(supplyInputs[i], values.recipients[i].amount);
      }
    }
  }

  return { step: 'create-token', filled: true };
}

/**
 * Fill Step 4: Voting Parameters
 * @param {Object} values - { votingModel, voteDelegation?, earlyCompletion?, executionDelay?,
 *   durationOfVoting, quorum, voteInProposals?, createProposals?,
 *   communityRewards?, rewardToken?, votingRewardsPercentage?, ... }
 * votingModel: 0=linear, 1=meritocratic, 2=custom
 */
function fillVotingParameters(values) {
  const S = {
    linear: 'Create DAO(Voting parameters)/Linear Voting Model radio button',
    meritocratic: 'Create DAO(Voting parameters)/Meritocratic Model radio button',
    custom: 'Create DAO(Voting parameters)/Custom Logic radio button',
    delegation: 'Create DAO(Voting parameters)/Vote delegation toggle',
    earlyCompletion: 'Create DAO(Voting parameters)/Early vote completion toggle',
    executionDelay: 'Create DAO(Voting parameters)/Execution delay input',
    duration: 'Create DAO(Voting parameters)/Duration of voting input',
    quorum: 'Create DAO(Voting parameters)/Votes needed for quorum input',
    voteInProposals: 'Create DAO(Voting parameters)/Vote in proposals input',
    createProposals: 'Create DAO(Voting parameters)/Create proposals input',
    communityRewards: 'Create DAO(Voting parameters)/Community rewards toggle',
    rewardToken: 'Create DAO(Voting parameters)/BEP-20 token for rewards input',
    readDiscussions: 'Create DAO(Voting parameters)/Read proposal discussion input',
    commentOnProposals: 'Create DAO(Voting parameters)/Comment on proposals input',
    approvedProposalRewards: 'Create DAO(Voting parameters)/Approved Proposal Rewards input',
    votingRewardsPercentage: 'Create DAO(Voting parameters)/Voting Rewards Percentage input',
    proposalExecutionReward: 'Create DAO(Voting parameters)/Proposal Execution Rewards input',
    customSmartContract: 'Create DAO(Voting parameters)/Custom smart contract address input',
    useGovTokenRewards: 'Create DAO(Voting parameters)/Use governance token for rewards checkbox',
  };

  // Voting model
  const modelMap = [S.linear, S.meritocratic, S.custom];
  clickTestId(modelMap[values.votingModel || 0]);

  // Toggles
  if (values.voteDelegation !== undefined) ensureToggle(S.delegation, values.voteDelegation);
  if (values.earlyCompletion !== undefined) ensureToggle(S.earlyCompletion, values.earlyCompletion);

  // Numeric inputs
  if (values.executionDelay) fillTestId(S.executionDelay, values.executionDelay);
  if (values.durationOfVoting) fillTestId(S.duration, values.durationOfVoting);
  if (values.quorum) fillTestId(S.quorum, values.quorum);
  if (values.voteInProposals) fillTestId(S.voteInProposals, values.voteInProposals);
  if (values.createProposals) fillTestId(S.createProposals, values.createProposals);

  // Community rewards
  if (values.communityRewards) {
    ensureToggle(S.communityRewards, true);
    if (values.rewardToken) fillTestId(S.rewardToken, values.rewardToken);
    if (values.votingRewardsPercentage) fillTestId(S.votingRewardsPercentage, values.votingRewardsPercentage);
    if (values.approvedProposalRewards) fillTestId(S.approvedProposalRewards, values.approvedProposalRewards);
    if (values.proposalExecutionReward) fillTestId(S.proposalExecutionReward, values.proposalExecutionReward);
  }

  // Custom vote power
  if (values.votingModel === 2 && values.customSmartContract) {
    fillTestId(S.customSmartContract, values.customSmartContract);
  }

  return { step: 'voting-parameters', filled: true };
}

/**
 * Fill Step 5: Validators (optional)
 * @param {Object} values - { enabled, tokenName?, tokenSymbol?, validators: [{address, supply}],
 *   quorum?, duration?, executionDelay? }
 */
function fillValidators(values) {
  const S = {
    toggle: 'Create DAO(Add validators)/Validator settings toggle',
    tokenName: 'Create DAO(Add validators)/Validator token name input',
    tokenSymbol: 'Create DAO(Add validators)/Validator token symbol input',
    address: 'Create DAO(Add validators)/Validator address input',
    supply: 'Create DAO(Add validators)/Validator supply input',
    newAddress: 'Create DAO(Add validators)/New address button',
    quorum: 'Create DAO(Add validators)/Votes needed for quorum input',
    duration: 'Create DAO(Add validators)/Duration of voting input',
    executionDelay: 'Create DAO(Add validators)/Execution delay input',
  };

  if (!values.enabled) return { step: 'validators', filled: true, skipped: true };

  ensureToggle(S.toggle, true);

  if (values.tokenName) fillTestId(S.tokenName, values.tokenName);
  if (values.tokenSymbol) fillTestId(S.tokenSymbol, values.tokenSymbol);

  // Validator addresses
  if (values.validators && values.validators.length > 0) {
    for (let i = 0; i < values.validators.length; i++) {
      if (i > 0) clickTestId(S.newAddress);
      const addrInputs = document.querySelectorAll(`[data-testid="${S.address}"]`);
      const supplyInputs = document.querySelectorAll(`[data-testid="${S.supply}"]`);
      if (addrInputs[i]) {
        setReactInput(addrInputs[i], values.validators[i].address);
        setReactInput(supplyInputs[i], values.validators[i].supply);
      }
    }
  }

  if (values.quorum) fillTestId(S.quorum, values.quorum);
  if (values.duration) fillTestId(S.duration, values.duration);
  if (values.executionDelay) fillTestId(S.executionDelay, values.executionDelay);

  return { step: 'validators', filled: true };
}

/**
 * Click the "Create DAO" button on the summary page.
 */
function submitDao() {
  clickTestId('Create DAO(Summry)/Create DAO button');
  return { step: 'submit', clicked: true };
}

// ─── Navigation Helpers ─────────────────────────────────────────────────────

/**
 * Click the "Next" button to advance the wizard.
 */
function nextStep() {
  clickTestId('Create DAO(road steps)/Next button');
  return { navigated: 'next' };
}

/**
 * Click a specific step button by name.
 */
function goToStep(stepName) {
  const stepMap = {
    'basic': 'Create DAO (road steps)/Basic DAO Settings button',
    'governance': 'Create DAO(road steps)/Governance button',
    'create-token': 'Create DAO(road steps)/Create own token button',
    'voting': 'Create DAO(road steps)/Votin parameters button',
    'validators': 'Create DAO(road steps)/Add validators (optional) button',
    'summary': 'Create DAO(road steps)/Summary button',
  };
  const testId = stepMap[stepName];
  if (!testId) throw new Error(`Unknown step: ${stepName}`);
  clickTestId(testId);
  return { navigated: stepName };
}

// Export for use in orchestrator
window.__DEXE_FORM_FILLER__ = {
  fillBasicSettings,
  fillGovernance,
  fillCreateToken,
  fillVotingParameters,
  fillValidators,
  submitDao,
  nextStep,
  goToStep,
  waitForTestId,
  // Low-level
  fillTestId,
  clickTestId,
  setReactInput,
  ensureToggle,
};

console.log('[dexe-compat] Form filler loaded. Access via window.__DEXE_FORM_FILLER__');
