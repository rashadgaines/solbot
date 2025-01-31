const socket = io();

// Connection status handling
socket.on('connect', () => {
    updateConnectionStatus(true);
});

socket.on('disconnect', () => {
    updateConnectionStatus(false);
});

socket.on('metrics-update', (metrics) => {
    updatePortfolio(metrics.portfolio);
    updateTracking(metrics.tracking);
    updateTransactions(metrics.transactions);
});

socket.on('metrics', (metrics) => {
    console.log('Received metrics:', metrics);
    if (metrics && metrics.balance) {
        const portfolioValueEl = document.getElementById('portfolio-value');
        const solBalanceEl = document.getElementById('sol-balance');
        
        if (portfolioValueEl) {
            portfolioValueEl.textContent = `$${metrics.balance.usd.toFixed(2)}`;
        }
        
        if (solBalanceEl) {
            solBalanceEl.textContent = `${metrics.balance.sol.toFixed(4)} SOL`;
        }
    }
});

// Dark mode handling
function initializeTheme() {
    const themeToggleDarkIcon = document.getElementById('theme-toggle-dark-icon');
    const themeToggleLightIcon = document.getElementById('theme-toggle-light-icon');

    // Change the icons inside the button based on previous settings
    if (localStorage.getItem('color-theme') === 'dark' || 
        (!('color-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        themeToggleLightIcon.classList.remove('hidden');
        document.documentElement.classList.add('dark');
    } else {
        themeToggleDarkIcon.classList.remove('hidden');
        document.documentElement.classList.remove('dark');
    }

    document.getElementById('theme-toggle').addEventListener('click', function() {
        // Toggle icons
        themeToggleDarkIcon.classList.toggle('hidden');
        themeToggleLightIcon.classList.toggle('hidden');

        // If is set in localStorage
        if (localStorage.getItem('color-theme')) {
            if (localStorage.getItem('color-theme') === 'light') {
                document.documentElement.classList.add('dark');
                localStorage.setItem('color-theme', 'dark');
            } else {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('color-theme', 'light');
            }
        } else {
            if (document.documentElement.classList.contains('dark')) {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('color-theme', 'light');
            } else {
                document.documentElement.classList.add('dark');
                localStorage.setItem('color-theme', 'dark');
            }
        }
    });
}

// Initialize theme when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeTheme);

function updateConnectionStatus(connected) {
    const status = document.getElementById('connection-status');
    if (connected) {
        status.className = 'inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-100';
        status.textContent = 'Connected';
    } else {
        status.className = 'inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-100';
        status.textContent = 'Disconnected';
    }
}

function updateTransactions(transactions) {
    const table = document.getElementById('transactions-table');
    table.innerHTML = transactions.map(tx => `
        <tr class="hover:bg-gray-50 dark:hover:bg-dark-300">
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                ${tx.token}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500 dark:text-gray-400">
                ${tx.type === 'Received' ? '+' : '-'}${tx.amount.toFixed(4)} SOL
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-gray-100">
                ${formatCurrency(tx.usdValue)}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                ${formatDate(tx.timestamp)}
            </td>
        </tr>
    `).join('');
}

function formatCurrency(value) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(value);
}

function formatDate(timestamp) {
    return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(new Date(timestamp));
} 