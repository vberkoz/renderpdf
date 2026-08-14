(function (global) {
    const instances = new Map();

    function init(root = document) {
        if (global.lucide) global.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
        root.querySelectorAll('[data-custom-select]').forEach((select) => {
            if (select.dataset.initialized === 'true') return;
            const trigger = select.querySelector('.custom-select-trigger');
            const menu = select.querySelector('.custom-select-menu');
            const input = select.querySelector('input[type="hidden"]');
            const label = select.querySelector('.custom-select-value');
            const accessibleLabel = select.querySelector('.custom-select-label');
            let options = [];
            if (!trigger || !menu || !input || !label) return;

            if (accessibleLabel) {
                if (!accessibleLabel.id) accessibleLabel.id = `${input.id}-label`;
                trigger.setAttribute('aria-labelledby', accessibleLabel.id);
            }

            const close = (restoreFocus = false) => {
                trigger.setAttribute('aria-expanded', 'false');
                menu.hidden = true;
                select.dataset.open = 'false';
                delete select.dataset.openDirection;
                if (restoreFocus) trigger.focus();
            };
            const sync = (value, emit = true) => {
                input.value = value;
                options.forEach((option) => {
                    const active = option.dataset.value === value;
                    option.classList.toggle('is-active', active);
                    option.setAttribute('aria-selected', String(active));
                });
                const active = options.find((option) => option.dataset.value === value) || options[0];
                label.textContent = active.textContent.trim();
                if (emit) input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const bindOptions = () => {
                options = Array.from(select.querySelectorAll('[data-custom-select-option]'));
                options.forEach((option) => option.addEventListener('click', () => { sync(option.dataset.value); close(true); }));
            };
            const open = () => {
                menu.hidden = false;
                trigger.setAttribute('aria-expanded', 'true');
                select.dataset.open = 'true';
                const triggerRect = trigger.getBoundingClientRect();
                const menuHeight = menu.getBoundingClientRect().height;
                select.dataset.openDirection = window.innerHeight - triggerRect.bottom < menuHeight + 12 && triggerRect.top > window.innerHeight - triggerRect.bottom ? 'up' : 'down';
                (options.find((option) => option.classList.contains('is-active')) || options[0]).focus();
            };

            trigger.addEventListener('click', () => menu.hidden ? open() : close());
            trigger.addEventListener('keydown', (event) => {
                if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
                if (event.key === 'Escape') close();
            });
            menu.addEventListener('keydown', (event) => {
                const index = options.indexOf(document.activeElement);
                if (event.key === 'Escape') { event.preventDefault(); close(true); }
                if (event.key === 'ArrowDown') { event.preventDefault(); options[Math.min(index + 1, options.length - 1)].focus(); }
                if (event.key === 'ArrowUp') { event.preventDefault(); options[Math.max(index - 1, 0)].focus(); }
                if (['Enter', ' '].includes(event.key) && document.activeElement.matches('[data-custom-select-option]')) { event.preventDefault(); document.activeElement.click(); }
            });
            bindOptions();
            if (!options.length) return;
            select.dataset.initialized = 'true';
            instances.set(input.id, {
                setValue: (value) => sync(value, false),
                close,
                replaceOptions: (groups, value = input.value) => {
                    menu.replaceChildren();
                    groups.forEach((group, index) => {
                        if (index > 0) {
                            const divider = document.createElement('div');
                            divider.className = 'custom-select-divider';
                            divider.setAttribute('role', 'separator');
                            menu.appendChild(divider);
                        }
                        if (group.label) {
                            const heading = document.createElement('div');
                            heading.className = 'custom-select-group-label';
                            heading.textContent = group.label;
                            menu.appendChild(heading);
                        }
                        group.options.forEach((item) => {
                            const option = document.createElement('button');
                            option.type = 'button';
                            option.className = 'custom-select-option';
                            option.setAttribute('role', 'option');
                            option.dataset.customSelectOption = '';
                            option.dataset.value = item.value;
                            option.textContent = item.label;
                            menu.appendChild(option);
                        });
                    });
                    bindOptions();
                    sync(options.some((option) => option.dataset.value === value) ? value : options[0].dataset.value, false);
                }
            });
            sync(input.value || options[0].dataset.value, false);
        });
    }

    document.addEventListener('pointerdown', (event) => {
        document.querySelectorAll('[data-custom-select][data-open="true"]').forEach((select) => {
            if (!select.contains(event.target)) instances.get(select.querySelector('input[type="hidden"]')?.id)?.close();
        });
    });

    global.customSelect = {
        init,
        setValue: (id, value) => instances.get(id)?.setValue(value),
        replaceOptions: (id, groups, value) => instances.get(id)?.replaceOptions(groups, value)
    };
}(window));
