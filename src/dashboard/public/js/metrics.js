function updateBalanceDisplay(metrics) {
    const balanceEl = document.getElementById('wallet-balance');
    if (balanceEl && metrics.balance) {
        balanceEl.innerHTML = `
            <div class="balance-sol">${metrics.balance.sol.toFixed(4)} SOL</div>
            <div class="balance-usd">$${metrics.balance.usd.toFixed(2)}</div>
        `;
    }
} 