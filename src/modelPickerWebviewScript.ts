/** Injected into chat webview HTML (plain JS, no TypeScript). */
export function getModelPickerWebviewScript(): string {
  return `
    function createModelPickerDropdown(root) {
      root.classList.add('custom-dropdown', 'model-picker-dropdown');
      var MENU_WIDTH = 380;
      var MAX_MENU_HEIGHT = 380;
      var MIN_AUTO_POOL = 3;
      var catalog = [];
      var catalogById = {};
      var autoPoolSet = new Set();
      var autoPoolOrder = [];
      var value = AUTO_MODEL;
      var lastManualModelId = '';
      var menuView = 'pick';
      var tierFilters = { free: false, paid: false };
      var searchQuery = '';
      var disabled = false;
      var chromeBuilt = false;
      var chromeView = '';

      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'dropdown-trigger pill-trigger model-trigger';
      trigger.title = 'Model';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      var labelEl = document.createElement('span');
      labelEl.className = 'dropdown-label';
      var chevronWrap = document.createElement('span');
      chevronWrap.className = 'dropdown-chevron-wrap';
      chevronWrap.innerHTML = CHEVRON_HTML;
      trigger.appendChild(labelEl);
      trigger.appendChild(chevronWrap);

      var menu = document.createElement('div');
      menu.className = 'dropdown-menu dropdown-menu-wide model-picker-menu is-closed';
      menu.hidden = true;
      menu.setAttribute('role', 'listbox');
      root.appendChild(trigger);
      root.appendChild(menu);

      var autoHeaderEl = null;
      var enableBtn = null;
      var disableBtn = null;
      var autoHintEl = null;
      var autoStatusEl = null;
      var pickSectionEl = null;
      var listEl = null;
      var searchEl = null;
      var tagFreeBtn = null;
      var tagPaidBtn = null;

      function isAutoActive() {
        return value === AUTO_MODEL;
      }

      function syncMenuView() {
        menuView = isAutoActive() ? 'autoActive' : 'pick';
      }

      function shortLabel(id) {
        if (id === AUTO_MODEL) return 'Auto';
        if (id.length > 24) return id.slice(0, 22) + '…';
        return id;
      }

      function updateTrigger() {
        labelEl.textContent = shortLabel(value);
        trigger.title = isAutoActive()
          ? 'Auto — picks from models you enabled'
          : value;
      }

      function tierMatches(m) {
        if (!tierFilters.free && !tierFilters.paid) return true;
        if (tierFilters.free && m.tier === 'free') return true;
        if (tierFilters.paid && m.tier === 'paid') return true;
        return false;
      }

      function filteredCatalog() {
        var q = searchQuery.trim().toLowerCase();
        return catalog.filter(function(m) {
          if (!tierMatches(m)) return false;
          if (q && m.id.toLowerCase().indexOf(q) === -1) return false;
          return true;
        });
      }

      function poolSortIndex(id) {
        var idx = autoPoolOrder.indexOf(id);
        return idx >= 0 ? idx : 999999;
      }

      function sortCatalogForDisplay(items) {
        var activeId = !isAutoActive() && value && value !== AUTO_MODEL ? value : '';
        return items.slice().sort(function(a, b) {
          var aPool = autoPoolSet.has(a.id);
          var bPool = autoPoolSet.has(b.id);
          if (aPool !== bPool) return aPool ? -1 : 1;
          if (aPool && bPool) {
            if (activeId) {
              if (a.id === activeId && b.id !== activeId) return -1;
              if (b.id === activeId && a.id !== activeId) return 1;
            }
            var ai = poolSortIndex(a.id);
            var bi = poolSortIndex(b.id);
            if (ai !== bi) return ai - bi;
          }
          return a.id.localeCompare(b.id);
        });
      }

      function syncCapabilityHint() {
        if (!modelCapabilityHintEl) return;
        var msg = '';
        if (isAutoActive()) {
          var hasVision = false;
          autoPoolSet.forEach(function(id) {
            var e = catalogById[id];
            if (e && e.supportsVision) hasVision = true;
          });
          if (autoPoolSet.size > 0 && !hasVision) {
            msg = 'None of your Auto models can read images or PDFs. Turn on a vision model in the model menu, or select one directly.';
          }
        } else {
          var entry = catalogById[value];
          var sv = entry ? entry.supportsVision : false;
          if (!sv) {
            msg = 'This model is text only — it cannot read images or PDFs. Choose a vision-capable model for photos and PDFs.';
          }
        }
        if (msg) {
          modelCapabilityHintEl.textContent = msg;
          modelCapabilityHintEl.classList.remove('hidden');
        } else {
          modelCapabilityHintEl.textContent = '';
          modelCapabilityHintEl.classList.add('hidden');
        }
      }

      function updateTagButtons() {
        if (tagFreeBtn) {
          tagFreeBtn.classList.toggle('active', tierFilters.free);
          tagFreeBtn.setAttribute('aria-pressed', tierFilters.free ? 'true' : 'false');
        }
        if (tagPaidBtn) {
          tagPaidBtn.classList.toggle('active', tierFilters.paid);
          tagPaidBtn.setAttribute('aria-pressed', tierFilters.paid ? 'true' : 'false');
        }
      }

      function updateAutoHeader() {
        if (!autoHeaderEl) return;
        var n = autoPoolSet.size;
        if (autoStatusEl) autoStatusEl.style.display = 'none';
        if (isAutoActive()) {
          if (enableBtn) enableBtn.style.display = 'none';
          if (disableBtn) disableBtn.style.display = '';
          if (autoHintEl) {
            autoHintEl.style.display = '';
            autoHintEl.textContent =
              'Each message picks one model from your pool (mode, prompt, and attachments). Disable Auto to choose a model yourself.';
          }
        } else {
          if (enableBtn) {
            enableBtn.style.display = '';
            var canEnable = n >= MIN_AUTO_POOL;
            enableBtn.disabled = !canEnable;
            enableBtn.classList.toggle('ready', canEnable);
            if (canEnable) {
              enableBtn.title = 'Enable Auto — route each message from your pool';
              enableBtn.setAttribute('aria-label', 'Enable Auto');
            } else {
              enableBtn.title =
                'Turn on at least ' + MIN_AUTO_POOL + ' models (teal switches) to enable Auto.';
              enableBtn.setAttribute(
                'aria-label',
                'Enable Auto — turn on at least ' + MIN_AUTO_POOL + ' models first'
              );
            }
          }
          if (disableBtn) disableBtn.style.display = 'none';
          if (autoHintEl) {
            autoHintEl.style.display = '';
            autoHintEl.textContent =
              'Auto picks one model from your pool per message (Ask, Plan, or Agent; length, code tasks, vision). ' +
              'Turn on at least ' + MIN_AUTO_POOL + ' models (teal switches), then Enable Auto. ' +
              'Tap a model name to use that model only.';
          }
        }
      }

      function selectModel(modelId) {
        if (!modelId || modelId === AUTO_MODEL) return;
        value = modelId;
        lastManualModelId = modelId;
        lastModelId = modelId;
        updateTrigger();
        syncCapabilityHint();
        close();
        vscode.postMessage({ type: 'setModel', modelId: modelId });
      }

      function enableAuto() {
        if (autoPoolSet.size < MIN_AUTO_POOL) {
          vscode.postMessage({
            type: 'error',
            message: 'Turn on at least ' + MIN_AUTO_POOL + ' models for Auto (use the switches below), then Enable Auto.'
          });
          return;
        }
        value = AUTO_MODEL;
        lastModelId = AUTO_MODEL;
        syncMenuView();
        updateTrigger();
        syncCapabilityHint();
        buildChrome();
        positionMenu();
        vscode.postMessage({ type: 'setModel', modelId: AUTO_MODEL });
      }

      function disableAuto() {
        var fallback = lastManualModelId;
        if (!fallback || fallback === AUTO_MODEL) {
          var arr = Array.from(autoPoolSet);
          fallback = arr.length ? arr[0] : '';
        }
        if (!fallback) {
          vscode.postMessage({
            type: 'error',
            message: 'Disable Auto failed: pick a model from the list after turning Auto off.'
          });
          return;
        }
        value = fallback;
        lastManualModelId = fallback;
        lastModelId = fallback;
        syncMenuView();
        updateTrigger();
        syncCapabilityHint();
        vscode.postMessage({ type: 'setModel', modelId: fallback });
        buildChrome();
        positionMenu();
        if (searchEl) searchEl.focus();
      }

      function renderList() {
        if (!listEl || menuView !== 'pick') return;
        listEl.innerHTML = '';
        var items = sortCatalogForDisplay(filteredCatalog());
        if (!items.length) {
          var empty = document.createElement('div');
          empty.className = 'model-picker-empty';
          empty.textContent = catalog.length ? 'No models match your search.' : 'Loading catalog…';
          listEl.appendChild(empty);
          updateAutoHeader();
          return;
        }
        items.forEach(function(m) {
          var row = document.createElement('div');
          row.className = 'model-picker-row';

          var idBtn = document.createElement('button');
          idBtn.type = 'button';
          idBtn.className = 'model-picker-row-id-btn' + (value === m.id ? ' selected' : '');
          idBtn.textContent = m.id;
          idBtn.title = 'Use ' + m.id + ' for chat';
          idBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            selectModel(m.id);
          });

          var sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'model-pool-switch' + (autoPoolSet.has(m.id) ? ' on' : '');
          sw.title = autoPoolSet.has(m.id) ? 'In Auto pool' : 'Add to Auto pool';
          sw.setAttribute('aria-label', 'Auto pool toggle for ' + m.id);
          sw.addEventListener('click', function(e) {
            e.stopPropagation();
            var on = !autoPoolSet.has(m.id);
            vscode.postMessage({ type: 'setAutoPoolModel', modelId: m.id, enabled: on });
          });

          row.appendChild(idBtn);
          row.appendChild(sw);
          listEl.appendChild(row);
        });
        updateAutoHeader();
      }

      function buildChrome() {
        menu.innerHTML = '';
        chromeBuilt = true;
        syncMenuView();
        chromeView = menuView;

        autoHeaderEl = document.createElement('div');
        autoHeaderEl.className = 'model-picker-auto-header';

        var titleRow = document.createElement('div');
        titleRow.className = 'model-picker-auto-title-row';
        var title = document.createElement('span');
        title.className = 'model-picker-auto-title';
        title.textContent = isAutoActive() ? 'Auto — on' : 'Auto';
        titleRow.appendChild(title);

        enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'model-picker-auto-action enable';
        enableBtn.textContent = 'Enable Auto';
        enableBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          enableAuto();
        });
        titleRow.appendChild(enableBtn);

        disableBtn = document.createElement('button');
        disableBtn.type = 'button';
        disableBtn.className = 'model-picker-auto-action disable';
        disableBtn.textContent = 'Disable Auto';
        disableBtn.style.display = 'none';
        disableBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          disableAuto();
        });
        titleRow.appendChild(disableBtn);

        autoHeaderEl.appendChild(titleRow);

        autoHintEl = document.createElement('div');
        autoHintEl.className = 'model-picker-auto-hint';
        autoHeaderEl.appendChild(autoHintEl);

        autoStatusEl = document.createElement('div');
        autoStatusEl.className = 'model-picker-auto-status';
        autoHeaderEl.appendChild(autoStatusEl);

        menu.appendChild(autoHeaderEl);

        if (menuView === 'pick') {
          pickSectionEl = document.createElement('div');
          pickSectionEl.className = 'model-picker-pick-section';

          var toolbar = document.createElement('div');
          toolbar.className = 'model-picker-toolbar';
          searchEl = document.createElement('input');
          searchEl.type = 'text';
          searchEl.className = 'model-picker-search';
          searchEl.placeholder = 'Search models…';
          searchEl.value = searchQuery;
          searchEl.setAttribute('autocomplete', 'off');
          searchEl.addEventListener('input', function() {
            searchQuery = searchEl.value;
            renderList();
          });
          searchEl.addEventListener('click', function(e) { e.stopPropagation(); });
          searchEl.addEventListener('keydown', function(e) { e.stopPropagation(); });
          toolbar.appendChild(searchEl);

          var tags = document.createElement('div');
          tags.className = 'model-picker-tags';
          tagFreeBtn = document.createElement('button');
          tagFreeBtn.type = 'button';
          tagFreeBtn.className = 'model-picker-tag';
          tagFreeBtn.textContent = 'Free';
          tagFreeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            tierFilters.free = !tierFilters.free;
            updateTagButtons();
            renderList();
          });
          tagPaidBtn = document.createElement('button');
          tagPaidBtn.type = 'button';
          tagPaidBtn.className = 'model-picker-tag';
          tagPaidBtn.textContent = 'Paid';
          tagPaidBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            tierFilters.paid = !tierFilters.paid;
            updateTagButtons();
            renderList();
          });
          tags.appendChild(tagFreeBtn);
          tags.appendChild(tagPaidBtn);
          toolbar.appendChild(tags);
          pickSectionEl.appendChild(toolbar);
          updateTagButtons();

          listEl = document.createElement('div');
          listEl.className = 'model-picker-list';
          pickSectionEl.appendChild(listEl);

          menu.appendChild(pickSectionEl);
          renderList();
        } else {
          pickSectionEl = null;
          listEl = null;
          searchEl = null;
          tagFreeBtn = null;
          tagPaidBtn = null;
          updateAutoHeader();
        }
      }

      function clearMenuPosition() {
        menu.style.top = '';
        menu.style.bottom = '';
        menu.style.left = '';
        menu.style.width = '';
        menu.style.minWidth = '';
        menu.style.maxWidth = '';
        menu.style.maxHeight = '';
        menu.style.display = '';
      }

      function positionMenu() {
        var rect = trigger.getBoundingClientRect();
        var gap = 4;
        var minOpen = 80;
        var spaceBelow = window.innerHeight - rect.bottom - gap - 8;
        var spaceAbove = rect.top - gap - 8;
        var openBelow = spaceBelow >= minOpen || spaceBelow >= spaceAbove;
        root.classList.remove('open-above');
        menu.style.position = 'fixed';
        menu.style.width = MENU_WIDTH + 'px';
        menu.style.minWidth = MENU_WIDTH + 'px';
        menu.style.maxWidth = 'min(380px, calc(100vw - 16px))';
        var menuLeft = rect.left;
        if (menuLeft + MENU_WIDTH > window.innerWidth - 8) {
          menuLeft = Math.max(8, window.innerWidth - MENU_WIDTH - 8);
        }
        menu.style.left = menuLeft + 'px';
        if (openBelow) {
          menu.style.top = (rect.bottom + gap) + 'px';
          menu.style.bottom = 'auto';
          menu.style.maxHeight = Math.min(MAX_MENU_HEIGHT, Math.max(48, spaceBelow)) + 'px';
        } else {
          root.classList.add('open-above');
          var maxH = Math.min(MAX_MENU_HEIGHT, Math.max(48, spaceAbove));
          menu.style.maxHeight = maxH + 'px';
          menu.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
          menu.style.top = 'auto';
        }
      }

      function open() {
        if (disabled) return;
        if (openDropdown && openDropdown !== api) openDropdown.close();
        openDropdown = api;
        syncMenuView();
        root.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        menu.classList.remove('is-closed');
        menu.hidden = false;
        menu.style.display = '';
        if (menu.parentNode !== document.body) document.body.appendChild(menu);
        buildChrome();
        requestAnimationFrame(function() {
          positionMenu();
          if (menuView === 'pick' && searchEl) searchEl.focus();
        });
      }

      function close() {
        root.classList.remove('open');
        root.classList.remove('open-above');
        trigger.setAttribute('aria-expanded', 'false');
        menu.classList.add('is-closed');
        menu.hidden = true;
        menu.style.display = 'none';
        clearMenuPosition();
        if (menu.parentNode === document.body) root.appendChild(menu);
        if (openDropdown === api) openDropdown = null;
      }

      trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (disabled) return;
        if (root.classList.contains('open')) close();
        else open();
      });

      var api = {
        setCatalog: function(items) {
          catalog = items || [];
          catalogById = {};
          catalog.forEach(function(m) { catalogById[m.id] = m; });
          if (root.classList.contains('open')) {
            if (chromeBuilt && menuView === 'pick') renderList();
            else if (chromeBuilt) updateAutoHeader();
            else buildChrome();
          }
        },
        applyState: function(state) {
          var nextId = state.selectedModelId || AUTO_MODEL;
          value = nextId;
          lastModelId = nextId;
          if (nextId !== AUTO_MODEL) {
            lastManualModelId = nextId;
          }
          autoPoolOrder = Array.isArray(state.autoPoolEnabled)
            ? state.autoPoolEnabled.slice()
            : [];
          autoPoolSet = new Set(autoPoolOrder);
          updateTrigger();
          syncCapabilityHint();
          if (root.classList.contains('open')) {
            var nextView = isAutoActive() ? 'autoActive' : 'pick';
            if (nextView !== chromeView) {
              buildChrome();
              positionMenu();
            } else {
              updateAutoHeader();
              if (menuView === 'pick') renderList();
            }
          }
        },
        setValue: function(v) {
          value = v;
          lastModelId = v;
          if (v !== AUTO_MODEL) lastManualModelId = v;
          syncMenuView();
          updateTrigger();
          syncCapabilityHint();
        },
        getValue: function() { return value; },
        setDisabled: function(d) {
          disabled = !!d;
          trigger.disabled = disabled;
          if (disabled) close();
        },
        close: close
      };

      updateTrigger();
      close();
      return api;
    }
  `;
}
