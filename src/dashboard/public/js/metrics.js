function updateBalanceDisplay(metrics) {
    // Update Portfolio Value
    const portfolioValueEl = document.getElementById('portfolio-value');
    if (portfolioValueEl && metrics.balance) {
        portfolioValueEl.innerHTML = `$${metrics.balance.usd.toFixed(2)}`;
    }

    // Update SOL Balance
    const solBalanceEl = document.getElementById('sol-balance');
    if (solBalanceEl && metrics.balance) {
        solBalanceEl.innerHTML = `${metrics.balance.sol.toFixed(4)} SOL`;
    }
} 