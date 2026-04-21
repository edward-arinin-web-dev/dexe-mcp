/**
 * Transaction Interceptor Script
 *
 * Injected into the browser page via Chrome DevTools MCP.
 * Hooks window.ethereum.request to capture eth_sendTransaction calldata
 * before MetaMask or any wallet processes it.
 *
 * Usage (via Chrome DevTools MCP javascript_tool):
 *   Inject this script, then trigger the form submit.
 *   Poll window.__DEXE_COMPAT_INTERCEPTOR__.captured for results.
 */

(function () {
  // Guard against double-injection
  if (window.__DEXE_COMPAT_INTERCEPTOR__) {
    console.log('[dexe-compat] Interceptor already active, resetting captures.');
    window.__DEXE_COMPAT_INTERCEPTOR__.captured = [];
    window.__DEXE_COMPAT_INTERCEPTOR__.listening = true;
    return;
  }

  const state = {
    captured: [],      // Array of { to, data, value, from, timestamp }
    listening: true,   // Set to false to stop capturing
    originalRequest: null,
  };

  // Hook window.ethereum.request
  function hookProvider(provider) {
    if (!provider || !provider.request) return false;
    if (provider.__dexeCompat_hooked) return true;

    const originalRequest = provider.request.bind(provider);
    state.originalRequest = originalRequest;

    provider.request = async function (args) {
      if (state.listening && args.method === 'eth_sendTransaction') {
        const tx = args.params?.[0] || args.params;
        const capture = {
          to: tx.to || null,
          data: tx.data || tx.input || null,
          value: tx.value || '0x0',
          from: tx.from || null,
          gasLimit: tx.gas || tx.gasLimit || null,
          timestamp: Date.now(),
          method: 'eth_sendTransaction',
        };
        state.captured.push(capture);
        console.log('[dexe-compat] Captured eth_sendTransaction:', capture.to, 'data length:', capture.data?.length);

        // BLOCK the actual transaction — don't send to wallet
        // Return a fake tx hash so the frontend doesn't crash
        const fakeTxHash = '0x' + 'de' + 'xe'.repeat(31);
        console.log('[dexe-compat] Transaction BLOCKED. Returning fake hash:', fakeTxHash);
        return fakeTxHash;
      }

      // Also capture eth_call if it targets the same contract (useful for gas estimation)
      if (state.listening && args.method === 'eth_estimateGas') {
        const tx = args.params?.[0] || args.params;
        console.log('[dexe-compat] Intercepted eth_estimateGas for:', tx.to);
        // Return a high gas estimate so the frontend proceeds
        return '0x1000000'; // ~16M gas
      }

      return originalRequest(args);
    };

    provider.__dexeCompat_hooked = true;
    console.log('[dexe-compat] Provider hooked successfully.');
    return true;
  }

  // Try to hook immediately
  if (window.ethereum) {
    hookProvider(window.ethereum);
  }

  // Also watch for late provider injection (some wallets inject after load)
  let hookAttempts = 0;
  const hookInterval = setInterval(() => {
    hookAttempts++;
    if (window.ethereum && !window.ethereum.__dexeCompat_hooked) {
      hookProvider(window.ethereum);
    }
    if (hookAttempts > 50 || window.ethereum?.__dexeCompat_hooked) {
      clearInterval(hookInterval);
    }
  }, 200);

  // Handle EIP-6963 providers (multi-wallet)
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (event.detail?.provider) {
      hookProvider(event.detail.provider);
    }
  });
  // Trigger discovery
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Expose the state globally for polling
  window.__DEXE_COMPAT_INTERCEPTOR__ = state;

  console.log('[dexe-compat] Interceptor installed. State at window.__DEXE_COMPAT_INTERCEPTOR__');
})();
