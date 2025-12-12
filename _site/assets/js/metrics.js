(function () {
    const namespaceMeta = document.querySelector('meta[name="countapi-namespace"]');

    if (!namespaceMeta) return;

    const namespace = namespaceMeta.content;

    function formatNumber(value) {
        if (typeof value !== 'number') return '0';
        return value.toLocaleString('en-US');
    }

    async function updateCounter(key, element, increment = false) {
        const endpoint = increment ? 'hit' : 'get';
        const url = 'https://api.countapi.xyz/'
            + endpoint
            + '/'
            + encodeURIComponent(namespace)
            + '/'
            + encodeURIComponent(key);

        try {
            const response = await fetch(url, { cache: 'no-cache' });
            const data = await response.json();
            const value = data.value ?? data.count ?? 0;

            if (element) element.innerText = formatNumber(value);
            return value;
        } catch (error) {
            if (element) element.innerText = '-';
            return null;
        }
    }

    window.CountAPI = {
        namespace,
        updateCounter,
        formatNumber,
    };

    const totalElement = document.querySelector('[data-count="total"]');
    const todayElement = document.querySelector('[data-count="today"]');
    const todayKey = new Date().toISOString().slice(0, 10);

    if (totalElement) updateCounter('site-total', totalElement, true);
    if (todayElement) updateCounter(`daily-${todayKey}`, todayElement, true);
})();
