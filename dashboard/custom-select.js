/* Shared custom-select construct, kept in sync with ExtractKit's workspace
   controls while supporting the dashboard's dynamically loaded options. */
window.customSelect = (() => {
    let initialized = false;

    const selects = () => [...document.querySelectorAll('[data-custom-select]')];
    const parts = (select) => ({
        trigger: select.querySelector('.custom-select-trigger'),
        menu: select.querySelector('.custom-select-menu'),
        input: select.querySelector('input[type="hidden"]'),
        value: select.querySelector('.custom-select-value'),
        label: select.querySelector('.custom-select-label')
    });
    const options = (select) => [...select.querySelectorAll('[data-custom-select-option]')];

    function ensureConstruct(select) {
        const { trigger, value, label } = parts(select);
        if (!trigger || !value || !label) return false;
        const input = select.querySelector('input[type="hidden"]');
        const baseId = input?.id || `custom-select-${Math.random().toString(36).slice(2)}`;
        if (!label.id) label.id = `${baseId}-label`;
        if (!value.id) value.id = `${baseId}-value-label`;
        trigger.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
        if (!trigger.querySelector('.custom-select-icon')) {
            const icon = document.createElement('span');
            icon.className = 'custom-select-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
            trigger.append(icon);
        }
        return true;
    }

    function sync(select, value, notify = true) {
        if (!ensureConstruct(select)) return;
        const { trigger, input, value: valueLabel, label } = parts(select);
        const optionList = options(select);
        const active = optionList.find((option) => option.dataset.value === value) || optionList[0];
        const nextValue = active?.dataset.value || value || '';
        if (input) input.value = nextValue;
        optionList.forEach((option) => {
            const selected = option === active;
            option.classList.toggle('is-active', selected);
            option.setAttribute('aria-selected', String(selected));
        });
        if (valueLabel) valueLabel.textContent = active?.textContent.trim() || nextValue;
        trigger?.setAttribute('aria-label', `${label?.textContent.trim() || ''} ${valueLabel?.textContent || ''}`.trim());
        if (notify && input) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function setExpanded(select, expanded) {
        if (!ensureConstruct(select)) return;
        const { trigger, menu } = parts(select);
        if (!trigger || !menu) return;
        trigger.setAttribute('aria-expanded', String(expanded));
        menu.hidden = !expanded;
        select.dataset.open = String(expanded);
        if (!expanded) {
            delete select.dataset.openDirection;
            return;
        }
        positionMenu(select, menu, trigger);
    }

    function positionMenu(select, menu, trigger) {
        const triggerRect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - triggerRect.bottom;
        const spaceAbove = triggerRect.top;
        select.dataset.openDirection = spaceBelow < menu.getBoundingClientRect().height + 12 && spaceAbove > spaceBelow ? 'up' : 'down';
    }

    function closeOutside(target) {
        selects().forEach((select) => {
            if (!select.contains(target)) setExpanded(select, false);
        });
    }

    function init() {
        selects().forEach((select) => {
            if (!ensureConstruct(select)) return;
            const { input } = parts(select);
            sync(select, input?.value || options(select)[0]?.dataset.value || '', false);
        });
        if (initialized) return;
        initialized = true;

        document.addEventListener('pointerdown', (event) => {
            if (event.target instanceof Element) closeOutside(event.target);
        });
        document.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const trigger = target?.closest('.custom-select-trigger');
            if (trigger) {
                const select = trigger.closest('[data-custom-select]');
                if (select) setExpanded(select, trigger.getAttribute('aria-expanded') !== 'true');
                return;
            }
            const option = target?.closest('[data-custom-select-option]');
            if (option) {
                const select = option.closest('[data-custom-select]');
                if (!select) return;
                sync(select, option.dataset.value || '');
                setExpanded(select, false);
                parts(select).trigger?.focus();
            }
        });
        document.addEventListener('keydown', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const trigger = target?.closest('.custom-select-trigger');
            if (trigger && ['ArrowDown', 'Enter', ' '].includes(event.key)) {
                event.preventDefault();
                const select = trigger.closest('[data-custom-select]');
                if (!select) return;
                setExpanded(select, true);
                options(select)[0]?.focus();
                return;
            }
            if (trigger && event.key === 'Escape') {
                const select = trigger.closest('[data-custom-select]');
                if (select) setExpanded(select, false);
                return;
            }
            const option = target?.closest('[data-custom-select-option]');
            const select = option?.closest('[data-custom-select]');
            if (!select) return;
            const optionList = options(select);
            const index = optionList.indexOf(option);
            if (event.key === 'Escape') {
                event.preventDefault(); setExpanded(select, false); parts(select).trigger?.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); optionList[Math.max(0, Math.min(optionList.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault(); optionList[event.key === 'Home' ? 0 : optionList.length - 1]?.focus();
            }
        });
        const reposition = () => selects().forEach((select) => {
            const { menu, trigger } = parts(select);
            if (select.dataset.open === 'true' && menu && trigger) positionMenu(select, menu, trigger);
        });
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, { passive: true });
    }

    function setValue(id, value) {
        const input = document.getElementById(id);
        const select = input?.closest('[data-custom-select]');
        // Programmatic updates are state synchronization, not a user choice.
        // Emitting `change` here would re-enter listeners that themselves call
        // setValue (for example, resetting the "new template" selection).
        if (select) sync(select, value, false);
    }

    function replaceOptions(id, groups, selectedValue) {
        const input = document.getElementById(id);
        const select = input?.closest('[data-custom-select]');
        const menu = select && parts(select).menu;
        if (!select || !menu) return;
        menu.replaceChildren();
        groups.forEach((group, groupIndex) => {
            if (group.label) {
                const heading = document.createElement('div');
                heading.className = 'custom-select-group-label';
                heading.textContent = group.label;
                menu.append(heading);
            }
            (group.options || []).forEach((item) => {
                const option = document.createElement('button');
                option.type = 'button'; option.className = 'custom-select-option'; option.role = 'option';
                option.dataset.customSelectOption = ''; option.dataset.value = item.value; option.textContent = item.label;
                menu.append(option);
            });
            if (groupIndex < groups.length - 1) {
                const divider = document.createElement('div'); divider.className = 'custom-select-divider'; divider.role = 'separator'; menu.append(divider);
            }
        });
        sync(select, selectedValue ?? input.value ?? options(select)[0]?.dataset.value ?? '', false);
    }

    return { init, setValue, replaceOptions };
})();
