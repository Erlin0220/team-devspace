(() => {
  const fallbackCopy = text => {
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  };

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-command]');
    if (!button) return;
    const command = button.closest('.command-card')?.querySelector('code')?.textContent?.trim();
    if (!command) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      copied = fallbackCopy(command);
    }
    if (!copied) return;
    const label = button.querySelector('.copy-label');
    if (!label) return;
    label.textContent = '已复制';
    button.dataset.state = 'copied';
    window.setTimeout(() => {
      label.textContent = '复制脚本';
      delete button.dataset.state;
    }, 1600);
  });
})();
