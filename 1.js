// ==UserScript==
// @name         Quizizz Bypass
// @version      51.0
// @description  Resolve questões do Quizizz
// @author       ricinuss
// @icon         https://tse1.mm.bing.net/th/id/OIP.Ydweh29BuHk_PGD4dGJXbAHaHa?rs=1&pid=ImgDetMain&o=7&rm=3
// @match        https://wayground.com/join/game/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════

    const CONFIG = {
        apiKeys: [
            "CHAVE_GEMINI_1",
            "CHAVE_GEMINI_2",
            "CHAVE_GEMINI_3"
        ],
        model: 'gemini-2.5-flash',
        get apiBaseUrl() {
            return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
        },
        timeouts: {
            fetch: 15000,
            elementWait: 5000,
            popperWait: 2000,
            uiDelay: 2000,
            keypadDelay: 100,
        },
        selectors: {
            questionText: '#questionText',
            questionImage: 'img[data-testid="question-container-image"]',
            optionText: '#optionText',
            dropdownButton: 'button.options-dropdown',
            popperShown: '.v-popper__popper--shown',
            dropdownOption: 'button.dropdown-option',
            equationEditor: 'div[data-cy="equation-editor"]',
            droppableBlank: 'button.droppable-blank',
            dragOption: '.drag-option',
            matchContainer: '.match-order-options-container, .question-options-layout',
            optionTile: '.match-order-option.is-option-tile',
            dropTile: '.match-order-option.is-drop-tile',
            openEndedTextarea: 'textarea[data-cy="open-ended-textarea"]',
            selectableOption: '.option.is-selectable',
            submitButton: '.submit-button-wrapper button, button.submit-btn',
        },
        highlightColors: ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF8C00', '#DA70D6'],
        quizIdRegex: /\/(?:quiz|quizzes|admin\/quiz|games|attempts|join)\/([a-f0-9]{24})/i,
    };

    // ═══════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════

    const state = {
        currentKeyIndex: 0,
        lastAiResponse: '',
        quizIdDetected: null,
        interceptorsStarted: false,
    };

    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════

    const Utils = {
        /**
         * Waits for element(s) to appear in the DOM.
         */
        waitForElement(selector, { all = false, timeout = CONFIG.timeouts.elementWait } = {}) {
            return new Promise((resolve, reject) => {
                const check = () => {
                    const result = all
                        ? document.querySelectorAll(selector)
                        : document.querySelector(selector);
                    const found = all ? result.length > 0 : !!result;
                    return found ? result : null;
                };

                // Check immediately first
                const immediate = check();
                if (immediate) return resolve(immediate);

                const startTime = Date.now();
                const interval = setInterval(() => {
                    const result = check();
                    if (result) {
                        clearInterval(interval);
                        resolve(result);
                    } else if (Date.now() - startTime > timeout) {
                        clearInterval(interval);
                        reject(new Error(`"${selector}" not found after ${timeout}ms`));
                    }
                }, 100);
            });
        },

        /**
         * Waits for an element to disappear from the DOM.
         */
        waitForDisappear(selector, timeout = CONFIG.timeouts.elementWait) {
            return new Promise((resolve, reject) => {
                if (!document.querySelector(selector)) return resolve();

                const startTime = Date.now();
                const interval = setInterval(() => {
                    if (!document.querySelector(selector)) {
                        clearInterval(interval);
                        resolve();
                    } else if (Date.now() - startTime > timeout) {
                        clearInterval(interval);
                        reject(new Error(`"${selector}" didn't disappear after ${timeout}ms`));
                    }
                }, 100);
            });
        },

        /**
         * Fetch with automatic timeout via AbortController.
         */
        async fetchWithTimeout(url, options = {}, timeout = CONFIG.timeouts.fetch) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                return response;
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error('Request timed out.');
                }
                throw error;
            } finally {
                clearTimeout(timer);
            }
        },

        /**
         * Converts an image URL to a base64 data URL.
         */
        async imageToBase64(url) {
            try {
                const cacheBust = new URL(url);
                cacheBust.searchParams.set('_t', Date.now());

                const response = await this.fetchWithTimeout(cacheBust.href, { cache: 'no-store' });
                const blob = await response.blob();

                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            } catch (e) {
                console.error(`Failed to convert image: ${e.message}`, url);
                return null;
            }
        },

        /**
         * Normalizes text for comparison (removes special chars, lowercases).
         */
        normalize(str) {
            if (typeof str !== 'string') return '';
            return str
                .replace(/[^a-zA-Z\u00C0-\u017F0-9\s²³]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        },

        /**
         * Cleans quotes and backticks from AI response text.
         */
        cleanQuotes(str) {
            return str.replace(/["'`]/g, '').trim();
        },

        /**
         * Extracts text from an option element, preferring MathML annotations.
         */
        extractOptionText(el) {
            const mathEl = el.querySelector('annotation[encoding="application/x-tex"]');
            if (mathEl) return mathEl.textContent.trim();
            return el.querySelector(CONFIG.selectors.optionText)?.innerText.trim() || '';
        },

        /**
         * Parses "A -> B" pairs from AI response text.
         */
        parsePairings(text) {
            return text
                .split('\n')
                .filter(line => line.includes('->'))
                .map(line => {
                    const parts = line.split('->');
                    if (parts.length !== 2) return null;
                    return [this.cleanQuotes(parts[0]), this.cleanQuotes(parts[1])];
                })
                .filter(Boolean);
        },

        /**
         * Simple delay promise.
         */
        delay(ms) {
            return new Promise(r => setTimeout(r, ms));
        },

        /**
         * Safely closes a popper if it's open.
         */
        async closePopper() {
            if (document.querySelector(CONFIG.selectors.popperShown)) {
                document.body.click();
                try {
                    await this.waitForDisappear(
                        CONFIG.selectors.popperShown,
                        CONFIG.timeouts.popperWait
                    );
                } catch {
                    console.warn('Popper did not close, continuing...');
                }
            }
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // QUESTION EXTRACTOR
    // ═══════════════════════════════════════════════════════════════

    const QuestionExtractor = {
        /**
         * Main extraction method - detects question type and extracts data.
         */
        async extract() {
            try {
                const base = this._extractBase();
                const { questionText, questionImageUrl } = base;

                // Try each detector in priority order
                const detectors = [
                    () => this._detectMultiDropdown(base),
                    () => this._detectSingleDropdown(base),
                    () => this._detectEquation(base),
                    () => this._detectMultiDragIntoBlank(base),
                    () => this._detectSingleDragIntoBlank(base),
                    () => this._detectMatchOrder(base),
                    () => this._detectOpenEnded(base),
                    () => this._detectChoiceOptions(base),
                ];

                for (const detect of detectors) {
                    const result = detect();
                    if (result) return result;
                }

                console.error('Unrecognized question type.');
                return null;
            } catch (error) {
                console.error('Error extracting question data:', error);
                return null;
            }
        },

        _extractBase() {
            const textEl = document.querySelector(CONFIG.selectors.questionText);
            const questionText = textEl
                ? textEl.innerText.trim().replace(/\s+/g, ' ')
                : 'Could not find question text.';

            const imgEl = document.querySelector(CONFIG.selectors.questionImage);
            const questionImageUrl = imgEl?.src || null;

            return { questionText, questionImageUrl, textElement: textEl };
        },

        _detectMultiDropdown({ questionText, questionImageUrl, textElement }) {
            const buttons = document.querySelectorAll(CONFIG.selectors.dropdownButton);
            if (buttons.length <= 1) return null;

            console.log('Multi-dropdown type detected.');

            // Build question text with placeholders
            let html = textElement?.innerHTML || '';
            buttons.forEach((btn, i) => {
                const wrapper = btn.closest('.dropdown-wrapper');
                if (wrapper) {
                    html = html.replace(wrapper.outerHTML, ` [RESPOSTA ${i + 1}] `);
                }
            });

            const temp = document.createElement('div');
            temp.innerHTML = html;
            const cleanText = temp.innerText.replace(/\s+/g, ' ').trim();

            const dropdowns = Array.from(buttons).map((btn, i) => ({
                button: btn,
                placeholder: `[RESPOSTA ${i + 1}]`,
            }));

            return {
                questionText: cleanText,
                questionImageUrl,
                questionType: 'multi_dropdown',
                dropdowns,
                allAvailableOptions: [], // Will be populated later
                _dropdownButtons: buttons,
            };
        },

        _detectSingleDropdown({ questionText, questionImageUrl }) {
            const buttons = document.querySelectorAll(CONFIG.selectors.dropdownButton);
            if (buttons.length !== 1) return null;

            return {
                questionText,
                questionImageUrl,
                questionType: 'dropdown',
                dropdownButton: buttons[0],
            };
        },

        _detectEquation({ questionText, questionImageUrl }) {
            if (!document.querySelector(CONFIG.selectors.equationEditor)) return null;

            return { questionText, questionImageUrl, questionType: 'equation' };
        },

        _detectMultiDragIntoBlank({ questionText, questionImageUrl }) {
            const blanks = document.querySelectorAll(CONFIG.selectors.droppableBlank);
            const drags = document.querySelectorAll(CONFIG.selectors.dragOption);
            if (blanks.length <= 1 || drags.length === 0) return null;

            const container = document.querySelector('.drag-drop-text > div');
            const dropZones = [];

            if (container) {
                const children = Array.from(container.children);
                children.forEach((child, i) => {
                    const blank = child.querySelector(CONFIG.selectors.droppableBlank);
                    if (!blank) return;

                    const prev = children[i - 1];
                    if (prev?.tagName === 'SPAN') {
                        const prompt = prev.innerText.trim()
                            .replace(/:\s*$/, '')
                            .replace(/\s+/g, ' ');
                        dropZones.push({ prompt, blankElement: blank });
                    }
                });
            }

            const draggableOptions = Array.from(drags).map(el => ({
                text: el.innerText.trim(),
                element: el,
            }));

            return {
                questionText: container?.innerText.trim() || questionText,
                questionImageUrl,
                questionType: 'multi_drag_into_blank',
                draggableOptions,
                dropZones,
            };
        },

        _detectSingleDragIntoBlank({ questionText, questionImageUrl }) {
            const blanks = document.querySelectorAll(CONFIG.selectors.droppableBlank);
            const drags = document.querySelectorAll(CONFIG.selectors.dragOption);
            if (blanks.length !== 1 || drags.length === 0) return null;

            const draggableOptions = Array.from(drags).map(el => ({
                text: el.querySelector('.dnd-option-text')?.innerText.trim() || '',
                element: el,
            }));

            return {
                questionText,
                questionImageUrl,
                questionType: 'drag_into_blank',
                draggableOptions,
                dropZone: { element: blanks[0] },
            };
        },

        _detectMatchOrder({ questionText, questionImageUrl }) {
            const container = document.querySelector(CONFIG.selectors.matchContainer);
            if (!container) return null;

            const optionTiles = Array.from(
                container.querySelectorAll(CONFIG.selectors.optionTile)
            );
            const dropTiles = Array.from(
                container.querySelectorAll(CONFIG.selectors.dropTile)
            );

            if (optionTiles.length === 0 || dropTiles.length === 0) return null;

            const isImageMatch = optionTiles[0].querySelector('.option-image')
                || optionTiles[0].dataset.type === 'image';

            if (isImageMatch) {
                return this._extractImageMatch(
                    questionText, questionImageUrl, optionTiles, dropTiles
                );
            }

            const draggableItems = optionTiles.map(el => ({
                text: Utils.extractOptionText(el),
                element: el,
            }));
            const dropZones = dropTiles.map(el => ({
                text: Utils.extractOptionText(el),
                element: el,
            }));

            const isReorder = questionText.toLowerCase().includes('reorder');

            return {
                questionText,
                questionImageUrl,
                questionType: isReorder ? 'reorder' : 'match_order',
                draggableItems,
                dropZones,
            };
        },

        _extractImageMatch(questionText, questionImageUrl, optionTiles, dropTiles) {
            console.log('Image-to-text match type detected.');

            const draggableItems = [];
            optionTiles.forEach((el, i) => {
                let imageUrl = null;

                // Try background-image
                const imgDiv = el.querySelector('.option-image');
                if (imgDiv) {
                    const bg = window.getComputedStyle(imgDiv).backgroundImage;
                    const match = bg?.match(/url\("(.+?)"\)/);
                    if (match) imageUrl = match[1];
                }

                // Fallback: data-cy attribute
                if (!imageUrl) {
                    const dataCy = el.dataset.cy;
                    if (dataCy?.includes('url(')) {
                        const match = dataCy.match(/url\((.+)\)/);
                        if (match) {
                            imageUrl = match[1].replace(/\?w=\d+&h=\d+$/, '');
                        }
                    }
                }

                if (imageUrl) {
                    draggableItems.push({
                        id: `IMAGEM ${i + 1}`,
                        imageUrl,
                        element: el,
                    });
                }
            });

            const dropZones = dropTiles.map(el => ({
                text: Utils.extractOptionText(el),
                element: el,
            }));

            return {
                questionText,
                questionImageUrl,
                questionType: 'match_image_to_text',
                draggableItems,
                dropZones,
            };
        },

        _detectOpenEnded({ questionText, questionImageUrl }) {
            const textarea = document.querySelector(CONFIG.selectors.openEndedTextarea);
            if (!textarea) return null;

            return {
                questionText,
                questionImageUrl,
                questionType: 'open_ended',
                answerElement: textarea,
            };
        },

        _detectChoiceOptions({ questionText, questionImageUrl }) {
            const options = document.querySelectorAll(CONFIG.selectors.selectableOption);
            if (options.length === 0) return null;

            const isMultiple = Array.from(options).some(el =>
                el.classList.contains('is-msq')
            );
            const optionData = Array.from(options).map(el => ({
                text: Utils.extractOptionText(el),
                element: el,
            }));

            return {
                questionText,
                questionImageUrl,
                questionType: isMultiple ? 'multiple_choice' : 'single_choice',
                options: optionData,
            };
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // PROMPT BUILDER
    // ═══════════════════════════════════════════════════════════════

    const PromptBuilder = {
        /**
         * Builds the text prompt based on question type.
         */
        build(quizData) {
            const builder = this._builders[quizData.questionType];
            if (!builder) {
                console.error(`No prompt builder for type: ${quizData.questionType}`);
                return '';
            }

            const { instruction, options } = builder(quizData);
            return [
                instruction,
                '',
                '---',
                `PERGUNTA: "${quizData.questionText}"`,
                '---',
                options,
            ].filter(Boolean).join('\n');
        },

        _builders: {
            multi_dropdown(data) {
                return {
                    instruction: `Esta é uma questão com múltiplas lacunas ([RESPOSTA X]). As opções disponíveis são um pool compartilhado e cada opção só pode ser usada uma vez. Determine a resposta correta para CADA placeholder. Responda com cada resposta em uma nova linha, no formato '[RESPOSTA X]: Resposta Correta'. Se algum placeholder não tiver uma resposta lógica no pool, omita-o.`,
                    options: 'Pool de Opções Disponíveis: ' + data.allAvailableOptions.join(', '),
                };
            },

            match_image_to_text(data) {
                const texts = data.dropZones.map(i => `- "${i.text}"`).join('\n');
                return {
                    instruction: `Esta é uma questão de combinar imagens com seus textos correspondentes. Para cada imagem, forneça o par correto no formato EXATO: 'Texto da Opção -> ID da Imagem' (ex: 90° -> IMAGEM 3), com cada par em uma nova linha.`,
                    options: `Opções de Texto (Locais para Soltar):\n${texts}`,
                };
            },

            match_order(data) {
                const draggables = data.draggableItems.map(i => `- "${i.text}"`).join('\n');
                const droppables = data.dropZones.map(i => `- "${i.text}"`).join('\n');
                return {
                    instruction: `Responda com os pares no formato EXATO: 'Texto do Local para Soltar -> Texto do Item para Arrastar', com cada par em uma nova linha.`,
                    options: `Itens para Arrastar:\n${draggables}\n\nLocais para Soltar:\n${droppables}`,
                };
            },

            multi_drag_into_blank(data) {
                const prompts = data.dropZones.map(i => `- "${i.prompt}"`).join('\n');
                const options = data.draggableOptions.map(i => `- "${i.text}"`).join('\n');
                return {
                    instruction: `Esta é uma questão de combinar múltiplas sentenças com suas expressões corretas. Responda com os pares no formato EXATO: 'Sentença da pergunta -> Expressão da opção', com cada par em uma nova linha.`,
                    options: `Sentenças:\n${prompts}\n\nExpressões (Opções):\n${options}`,
                };
            },

            equation(data) {
                return {
                    instruction: `Resolva a seguinte equação ou inequação. Forneça apenas a expressão final simplificada (ex: x = 5, ou y > 3).`,
                    options: `EQUAÇÃO: "${data.questionText}"`,
                };
            },

            dropdown(data) {
                const opts = data.options?.map(o => `- "${o.text}"`).join('\n') || '';
                return {
                    instruction: `Responda APENAS com o texto exato da ÚNICA alternativa correta.`,
                    options: `OPÇÕES:\n${opts}`,
                };
            },

            single_choice(data) {
                const opts = data.options.map(o => `- "${o.text}"`).join('\n');
                return {
                    instruction: `Responda APENAS com o texto exato da ÚNICA alternativa correta.`,
                    options: `OPÇÕES:\n${opts}`,
                };
            },

            multiple_choice(data) {
                const opts = data.options.map(o => `- "${o.text}"`).join('\n');
                return {
                    instruction: `Responda APENAS com os textos exatos de TODAS as alternativas corretas, separando cada uma em uma NOVA LINHA.`,
                    options: `OPÇÕES:\n${opts}`,
                };
            },

            reorder(data) {
                const items = data.draggableItems.map(i => `- "${i.text}"`).join('\n');
                return {
                    instruction: `A tarefa é: "${data.questionText}". Forneça a ordem correta listando os textos dos itens, um por linha, do primeiro ao último.`,
                    options: `Itens para ordenar:\n${items}`,
                };
            },

            drag_into_blank(data) {
                const opts = data.draggableOptions.map(i => `- "${i.text}"`).join('\n');
                return {
                    instruction: `Responda APENAS com o texto da ÚNICA opção correta que preenche a lacuna.`,
                    options: `Opções para arrastar:\n${opts}`,
                };
            },

            open_ended() {
                return {
                    instruction: `Responda APENAS com a palavra ou frase curta que preenche a lacuna.`,
                    options: '',
                };
            },
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // AI SERVICE
    // ═══════════════════════════════════════════════════════════════

    const AIService = {
        /**
         * Sends question data to Gemini and returns the AI response.
         */
        async getAnswer(quizData) {
            state.lastAiResponse = '';
            UI.hideResponseButton();

            const textPrompt = PromptBuilder.build(quizData);
            const parts = await this._buildParts(textPrompt, quizData);

            return this._tryAllKeys(parts);
        },

        /**
         * Builds the multimodal parts array for the Gemini API.
         */
        async _buildParts(textPrompt, quizData) {
            const parts = [{ text: textPrompt }];

            // Add question image if present
            if (quizData.questionImageUrl) {
                const imagePart = await this._createImagePart(quizData.questionImageUrl);
                if (imagePart) parts.push(imagePart);
            }

            // Add draggable images for image match questions
            if (quizData.questionType === 'match_image_to_text') {
                parts.push({ text: '\n\nIMAGENS (Itens para Arrastar):\n' });
                for (const item of quizData.draggableItems) {
                    const imagePart = await this._createImagePart(item.imageUrl);
                    if (imagePart) {
                        parts.push(imagePart);
                        parts.push({ text: `- ${item.id}` });
                    }
                }
            }

            return parts;
        },

        /**
         * Creates an inline_data image part for the API.
         */
        async _createImagePart(url) {
            const base64 = await Utils.imageToBase64(url);
            if (!base64) return null;

            const [header, data] = base64.split(',');
            let mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
                mimeType = 'image/jpeg';
            }

            return { inline_data: { mime_type: mimeType, data } };
        },

        /**
         * Tries each API key in rotation until one succeeds.
         */
        async _tryAllKeys(parts) {
            const keys = CONFIG.apiKeys;
            let lastError = '';

            for (let i = 0; i < keys.length; i++) {
                const key = keys[state.currentKeyIndex];

                // Skip placeholder keys
                if (!key || key.includes('SUA_') || key.includes('CHAVE_') || key.length < 30) {
                    console.warn(`API key #${state.currentKeyIndex + 1} is a placeholder. Skipping...`);
                    state.currentKeyIndex = (state.currentKeyIndex + 1) % keys.length;
                    continue;
                }

                const url = `${CONFIG.apiBaseUrl}?key=${key}`;

                try {
                    const response = await Utils.fetchWithTimeout(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts }] }),
                    });

                    if (response.ok) {
                        const data = await response.json();
                        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!text) throw new Error('Empty response from API.');

                        console.log(`Success with API key #${state.currentKeyIndex + 1}.`);
                        console.log('Raw AI response:', text);
                        state.lastAiResponse = text;
                        return text;
                    }

                    const errorData = await response.json().catch(() => ({}));
                    lastError = errorData.error?.message || `Error ${response.status}`;
                    console.warn(`Key #${state.currentKeyIndex + 1} failed: ${lastError}`);
                } catch (error) {
                    lastError = error.message;
                    console.warn(`Key #${state.currentKeyIndex + 1} error: ${lastError}`);
                }

                state.lastAiResponse = `Key #${state.currentKeyIndex + 1} failed: ${lastError}`;
                state.currentKeyIndex = (state.currentKeyIndex + 1) % keys.length;
            }

            throw new Error('All Gemini API keys failed.');
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // ACTION PERFORMER
    // ═══════════════════════════════════════════════════════════════

    const ActionPerformer = {
        /**
         * Executes the appropriate action based on question type and AI answer.
         */
        async perform(aiAnswer, quizData) {
            if (!aiAnswer) return;

            const handler = this._handlers[quizData.questionType];
            if (handler) {
                await handler.call(this, aiAnswer, quizData);
            } else {
                this._handleChoice(aiAnswer, quizData);
            }
        },

        _handlers: {
            multi_dropdown: async function (aiAnswer, quizData) {
                await MultiDropdownHandler.execute(aiAnswer, quizData);
            },

            multi_drag_into_blank(aiAnswer, quizData) {
                const pairings = Utils.parsePairings(aiAnswer);
                if (pairings.length === 0) {
                    console.error('Could not extract valid pairs from AI response.');
                    return;
                }

                const dragMap = new Map(quizData.draggableOptions.map(i => [i.text, i.element]));
                const dropMap = new Map(quizData.dropZones.map(i => [i.prompt, i.blankElement]));

                let colorIdx = 0;
                for (const [promptText, optionText] of pairings) {
                    const bestKey = [...dropMap.keys()].find(
                        k => k.includes(promptText) || promptText.includes(k)
                    );
                    const blankEl = dropMap.get(bestKey);
                    const optionEl = dragMap.get(optionText);

                    if (blankEl && optionEl) {
                        HighlightHelper.applyColor(blankEl, optionEl, colorIdx++);
                    } else {
                        console.warn(`Pair not found in DOM: "${promptText}" -> "${optionText}"`);
                    }
                }
            },

            equation: async function (aiAnswer) {
                await EquationHandler.type(aiAnswer);
            },

            reorder(aiAnswer, quizData) {
                const items = aiAnswer.split('\n').map(Utils.cleanQuotes).filter(Boolean);
                const dragMap = new Map(quizData.draggableItems.map(i => [i.text, i.element]));
                const drops = quizData.dropZones;

                if (items.length !== drops.length) {
                    console.warn(`Reorder count mismatch: ${items.length} vs ${drops.length}`);
                    return;
                }

                items.forEach((text, i) => {
                    const sourceEl = dragMap.get(text);
                    const destEl = drops[i].element;
                    if (sourceEl && destEl) {
                        const color = HighlightHelper.getElementColor(sourceEl);
                        HighlightHelper.applyStyle(sourceEl, color);
                        HighlightHelper.applyStyle(destEl, color);
                    }
                });
            },

            drag_into_blank(aiAnswer, quizData) {
                const cleaned = Utils.cleanQuotes(aiAnswer.trim());
                const target = quizData.draggableOptions.find(o => o.text === cleaned);

                if (target) {
                    const color = HighlightHelper.getElementColor(target.element);
                    HighlightHelper.applyStyle(target.element, color);
                    HighlightHelper.applyStyle(quizData.dropZone.element, color);
                }
            },

            match_image_to_text(aiAnswer, quizData) {
                MatchHandler.highlightPairs(aiAnswer, quizData, true);
            },

            match_order(aiAnswer, quizData) {
                MatchHandler.highlightPairs(aiAnswer, quizData, false);
            },

            open_ended: async function (aiAnswer, quizData) {
                const el = quizData.answerElement;
                el.focus();
                el.value = aiAnswer.trim();
                el.dispatchEvent(new Event('input', { bubbles: true }));
                await Utils.delay(100);
                await Utils.delay(500);
                document.querySelector(CONFIG.selectors.submitButton)?.click();
            },
        },

        _handleChoice(aiAnswer, quizData) {
            if (quizData.questionType === 'multiple_choice') {
                const answers = aiAnswer.split('\n').map(Utils.normalize).filter(Boolean);
                quizData.options.forEach(opt => {
                    if (answers.includes(Utils.normalize(opt.text))) {
                        opt.element.style.border = '5px solid #00FF00';
                        opt.element.click();
                    }
                });
            } else if (quizData.questionType === 'single_choice') {
                const normalized = Utils.normalize(aiAnswer);
                const match = quizData.options.find(
                    o => Utils.normalize(o.text) === normalized
                );

                if (match) {
                    console.log('Match found!', match.element);
                    match.element.style.border = '5px solid #00FF00';
                    match.element.click();
                } else {
                    console.warn('No exact match found after normalization.');
                }
            }
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // SPECIALIZED HANDLERS
    // ═══════════════════════════════════════════════════════════════

    const HighlightHelper = {
        getElementColor(element) {
            const style = window.getComputedStyle(element);
            const bg = style.backgroundImage;
            if (bg?.includes('gradient')) {
                const match = bg.match(/rgb\(\d+, \d+, \d+\)/);
                if (match) return match[0];
            }
            return style.backgroundColor || 'rgba(0, 255, 0, 0.5)';
        },

        applyStyle(el, color) {
            el.style.cssText = `box-shadow: 0 0 15px 5px ${color}; border-radius: 8px;`;
        },

        applyColor(el1, el2, index) {
            const color = CONFIG.highlightColors[index % CONFIG.highlightColors.length];
            const style = `box-shadow: 0 0 15px 5px ${color}; border-radius: 4px;`;
            el1.style.cssText = style;
            el2.style.cssText = style;
        },
    };

    const MatchHandler = {
        highlightPairs(aiAnswer, quizData, isImageMatch) {
            const pairings = Utils.parsePairings(aiAnswer);
            if (pairings.length === 0) {
                console.error('Could not extract valid pairs from AI response.');
                return;
            }

            const dragMap = isImageMatch
                ? new Map(quizData.draggableItems.map(i => [i.id, i.element]))
                : new Map(quizData.draggableItems.map(i => [i.text, i.element]));
            const dropMap = new Map(quizData.dropZones.map(i => [i.text, i.element]));

            let colorIdx = 0;
            for (const [partA, partB] of pairings) {
                let sourceEl, destEl;

                // Try both orderings
                const cleanA = isImageMatch ? partA.replace(/[\[\]]/g, '') : partA;
                const cleanB = isImageMatch ? partB.replace(/[\[\]]/g, '') : partB;

                if (dropMap.has(cleanA) && dragMap.has(cleanB)) {
                    destEl = dropMap.get(cleanA);
                    sourceEl = dragMap.get(cleanB);
                } else if (dropMap.has(cleanB) && dragMap.has(cleanA)) {
                    destEl = dropMap.get(cleanB);
                    sourceEl = dragMap.get(cleanA);
                } else {
                    console.warn(`Unmapped pair: "${partA}" -> "${partB}"`);
                    continue;
                }

                if (sourceEl && destEl) {
                    if (isImageMatch) {
                        HighlightHelper.applyColor(sourceEl, destEl, colorIdx++);
                    } else {
                        const color = HighlightHelper.getElementColor(sourceEl);
                        HighlightHelper.applyStyle(sourceEl, color);
                        HighlightHelper.applyStyle(destEl, color);
                    }
                }
            }
        },
    };

    const MultiDropdownHandler = {
        async execute(aiAnswer, quizData) {
            const { popperShown } = CONFIG.selectors;
            const placeholderText = 'Selecionar resposta';

            // Parse AI answers
            const answers = aiAnswer.split('\n')
                .map(line => {
                    const match = line.match(/\[RESPOSTA (\d+)\]:\s*(.*)/i);
                    if (!match) return null;
                    return {
                        index: parseInt(match[1], 10) - 1,
                        answer: match[2].trim().replace(/["'`]/g, ''),
                    };
                })
                .filter(Boolean);

            const answersMap = new Map(answers.map(a => [a.index, a.answer]));

            // Phase 1: Clear wrong/unnecessary selections
            console.log('Phase 1: Clearing incorrect dropdown values...');
            for (let i = 0; i < quizData.dropdowns.length; i++) {
                const dd = quizData.dropdowns[i];
                const currentText = dd.button.innerText.trim();
                const target = answersMap.get(i);

                const isFilled = currentText !== placeholderText;
                const needsClear = isFilled && (!target || currentText !== target);

                if (needsClear) {
                    console.log(`Clearing dropdown #${i + 1} ("${currentText}")...`);
                    await this._clickDropdownOption(dd.button, currentText, popperShown);
                }
            }

            // Phase 2: Fill correct answers
            console.log('Phase 2: Filling correct answers...');
            for (const { index, answer } of answers) {
                const dd = quizData.dropdowns[index];
                if (!dd) {
                    console.error(`Dropdown at index ${index} not found.`);
                    continue;
                }

                if (dd.button.innerText.trim() === answer) continue;

                dd.button.click();
                try {
                    const options = await Utils.waitForElement(
                        `${popperShown} ${CONFIG.selectors.dropdownOption}`,
                        { all: true, timeout: CONFIG.timeouts.popperWait }
                    );
                    const target = Array.from(options).find(
                        el => el.innerText.trim() === answer
                    );

                    if (target && !target.disabled && !target.classList.contains('used-option')) {
                        target.click();
                    } else {
                        console.warn(`Option "${answer}" not available for dropdown #${index + 1}`);
                        document.body.click();
                    }
                    await Utils.waitForDisappear(popperShown, CONFIG.timeouts.popperWait)
                        .catch(() => {});
                } catch (e) {
                    console.error(`Error selecting dropdown #${index + 1}: ${e.message}`);
                    await Utils.closePopper();
                }
            }
        },

        async _clickDropdownOption(button, text, popperSelector) {
            button.click();
            try {
                const options = await Utils.waitForElement(
                    `${popperSelector} ${CONFIG.selectors.dropdownOption}`,
                    { all: true, timeout: CONFIG.timeouts.popperWait }
                );
                const target = Array.from(options).find(el => el.innerText.trim() === text);
                if (target) {
                    target.click();
                } else {
                    document.body.click();
                }
                await Utils.waitForDisappear(popperSelector, CONFIG.timeouts.popperWait)
                    .catch(() => {});
            } catch (e) {
                console.error(`Error clearing dropdown: ${e.message}`);
                await Utils.closePopper();
            }
        },
    };

    const EquationHandler = {
        KEYPAD_MAP: {
            '0': 'icon-fas-0', '1': 'icon-fas-1', '2': 'icon-fas-2',
            '3': 'icon-fas-3', '4': 'icon-fas-4', '5': 'icon-fas-5',
            '6': 'icon-fas-6', '7': 'icon-fas-7', '8': 'icon-fas-8',
            '9': 'icon-fas-9', '+': 'icon-fas-plus', '-': 'icon-fas-minus',
            '*': 'icon-fas-times', '×': 'icon-fas-times', '/': 'icon-fas-divide',
            '÷': 'icon-fas-divide', '=': 'icon-fas-equals', '.': 'icon-fas-period',
            '<': 'icon-fas-less-than', '>': 'icon-fas-greater-than',
            '≤': 'icon-fas-less-than-equal', '≥': 'icon-fas-greater-than-equal',
            'x': 'icon-fas-variable', 'y': 'icon-fas-variable', 'z': 'icon-fas-variable',
            '(': 'icon-fas-brackets-round', ')': 'icon-fas-brackets-round',
            'π': 'icon-fas-pi', 'e': 'icon-fas-euler',
        },

        async type(aiAnswer) {
            const sequence = aiAnswer.trim()
                .replace(/\s/g, '')
                .replace(/<=/g, '≤')
                .replace(/>=/g, '≥');

            console.log(`Typing equation answer: ${sequence}`);

            const editor = document.querySelector(CONFIG.selectors.equationEditor);
            if (!editor) {
                console.error('Equation editor not found.');
                return;
            }

            editor.click();
            await Utils.delay(CONFIG.timeouts.keypadDelay);

            for (const char of sequence) {
                const iconClass = this.KEYPAD_MAP[char.toLowerCase()];
                if (!iconClass) {
                    console.error(`Unmapped character: "${char}"`);
                    continue;
                }

                const icon = document.querySelector(`.editor-button i.${iconClass}`);
                const button = icon?.closest('button');
                if (button) {
                    button.click();
                    await Utils.delay(CONFIG.timeouts.keypadDelay);
                } else {
                    console.error(`Key not found for: "${char}" (${iconClass})`);
                }
            }
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // MAIN SOLVER
    // ═══════════════════════════════════════════════════════════════

    async function solveQuestion() {
        const button = document.getElementById('ai-solver-button');
        UI.setButtonState(button, true);

        try {
            const quizData = await QuestionExtractor.extract();
            if (!quizData) {
                alert('Não foi possível extrair os dados da questão.');
                return;
            }

            // Multi-dropdown: need to populate options pool first
            if (quizData.questionType === 'multi_dropdown') {
                await populateDropdownOptions(quizData);
                const aiAnswer = await AIService.getAnswer(quizData);
                if (aiAnswer) await ActionPerformer.perform(aiAnswer, quizData);
                return;
            }

            // Single dropdown: open it first to get options
            if (quizData.questionType === 'dropdown') {
                await handleSingleDropdown(quizData);
                return;
            }

            // Local math solver shortcut
            if (tryLocalMathSolver(quizData)) return;

            // Default: use AI
            console.log('Using AI to solve...');
            const aiAnswer = await AIService.getAnswer(quizData);
            if (aiAnswer) await ActionPerformer.perform(aiAnswer, quizData);
        } catch (error) {
            console.error('Unexpected error in solve flow:', error);
            if (!error.message?.includes('cancelada')) {
                alert('Erro: ' + error.message);
            }
        } finally {
            UI.setButtonState(button, false);
            UI.showResponseButtonIfNeeded();
        }
    }

    async function populateDropdownOptions(quizData) {
        const firstBtn = quizData._dropdownButtons[0];
        firstBtn.click();
        try {
            const optionEls = await Utils.waitForElement(
                `${CONFIG.selectors.popperShown} ${CONFIG.selectors.dropdownOption}`,
                { all: true, timeout: CONFIG.timeouts.popperWait }
            );
            quizData.allAvailableOptions = Array.from(optionEls)
                .map(el => el.innerText.trim());
            console.log('Options pool detected:', quizData.allAvailableOptions);
        } catch (e) {
            console.error('Failed to read dropdown options pool.', e);
        }
        await Utils.closePopper();
    }

    async function handleSingleDropdown(quizData) {
        console.log('Optimized dropdown flow...');
        quizData.dropdownButton.click();

        try {
            const optionEls = await Utils.waitForElement(
                `${CONFIG.selectors.popperShown} ${CONFIG.selectors.dropdownOption}`,
                { all: true }
            );
            quizData.options = Array.from(optionEls).map(el => ({
                text: el.innerText.trim(),
            }));

            const aiAnswer = await AIService.getAnswer(quizData);
            if (aiAnswer) {
                const cleaned = Utils.cleanQuotes(aiAnswer.trim());
                const target = Array.from(optionEls).find(
                    el => el.innerText.trim() === cleaned
                );

                if (target) {
                    target.click();
                } else {
                    console.error(`Dropdown option not found: "${cleaned}"`);
                    document.body.click();
                }
            } else {
                document.body.click();
            }
        } catch (error) {
            console.error('Failed to process dropdown:', error.message);
            document.body.click();
        }
    }

    function tryLocalMathSolver(quizData) {
        if (!quizData.options || quizData.options.length === 0) return false;

        const isMath = quizData.options[0].text.includes('\\')
            || quizData.questionText.toLowerCase().includes('value of');
        const matchValue = quizData.questionText.match(/value of ([\d.]+)/i);

        if (!isMath || !matchValue) return false;

        console.log('Math question detected. Solving locally...');
        const targetValue = parseFloat(matchValue[1]);

        quizData.options.forEach(option => {
            const expr = option.text
                .replace(/\\left|\\right/g, '')
                .replace(/\\div/g, '/')
                .replace(/\\times/g, '*')
                .replace(/\\ /g, '')
                .replace(/(\d+)\s*\(/g, '$1 * (')
                .replace(/\)\s*(\d+)/g, ') * $1')
                .replace(/(\d+)\\frac\{(\d+)\}\{(\d+)\}/g, '($1+$2/$3)')
                .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '($1/$2)');

            try {
                const result = new Function('return ' + expr)();
                if (result !== null && Math.abs(result - targetValue) < 0.001) {
                    option.element.style.border = '5px solid #00FF00';
                    option.element.click();
                }
            } catch {
                // Expression evaluation failed, skip
            }
        });

        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // UI MODULE
    // ═══════════════════════════════════════════════════════════════

    const UI = {
        setButtonState(button, loading) {
            if (!button) return;
            button.disabled = loading;
            button.innerText = loading ? 'Pensando...' : '✨ Resolver';
            button.style.transform = loading ? 'scale(0.95)' : 'scale(1)';
            button.style.boxShadow = loading
                ? '0 0 0 rgba(0,0,0,0)'
                : '0 2px 8px rgba(0, 0, 0, 0.2)';
        },

        hideResponseButton() {
            const btn = document.getElementById('view-raw-response-btn');
            if (btn) btn.style.display = 'none';
        },

        showResponseButtonIfNeeded() {
            const btn = document.getElementById('view-raw-response-btn');
            if (btn && state.lastAiResponse) {
                btn.style.display = 'block';
            }
        },

        createElement(tag, styles = {}, attrs = {}) {
            const el = document.createElement(tag);
            Object.assign(el.style, styles);
            Object.entries(attrs).forEach(([k, v]) => {
                if (k === 'innerHTML') el.innerHTML = v;
                else if (k === 'innerText') el.innerText = v;
                else el.setAttribute(k, v);
            });
            return el;
        },

        createPanel() {
            if (document.getElementById('mzzvxm-floating-panel')) return;

            const panel = this.createElement('div', {
                position: 'fixed', bottom: '60px', right: '20px',
                zIndex: '2147483647', display: 'flex', flexDirection: 'column',
                alignItems: 'stretch', gap: '10px', padding: '12px',
                backgroundColor: 'rgba(26, 27, 30, 0.7)',
                backdropFilter: 'blur(8px)', webkitBackdropFilter: 'blur(8px)',
                borderRadius: '16px', boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
                transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
                transform: 'translateY(20px)', opacity: '0', cursor: 'default',
            }, { id: 'mzzvxm-floating-panel' });

            // Response viewer popup
            const responseViewer = this._createResponseViewer();
            panel.appendChild(responseViewer);

            // View response button
            const viewBtn = this._createViewResponseButton(responseViewer);
            panel.appendChild(viewBtn);

            // Toggle visibility button
            const toggleBtn = this._createToggleButton();
            panel.appendChild(toggleBtn);

            // Solve button
            const solveBtn = this._createSolveButton();
            panel.appendChild(solveBtn);

            // Watermark
            const watermark = this._createWatermark();
            panel.appendChild(watermark);

            document.body.appendChild(panel);

            // Setup toggle logic
            this._setupToggle(toggleBtn, ['view-raw-response-btn', 'ai-solver-button', 'mzzvxm-watermark']);

            // Make draggable
            this._makeDraggable(panel);

            // Animate in
            requestAnimationFrame(() => {
                panel.style.transform = 'translateY(0)';
                panel.style.opacity = '1';
            });

            console.log('Floating panel created successfully!');
        },

        _createResponseViewer() {
            return this.createElement('div', {
                display: 'none', position: 'absolute',
                bottom: 'calc(100% + 10px)', right: '0',
                width: '300px', maxHeight: '200px', overflowY: 'auto',
                background: 'rgba(10, 10, 15, 0.9)', backdropFilter: 'blur(5px)',
                borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.2)',
                padding: '12px', color: '#f0f0f0', fontSize: '12px',
                fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)', textAlign: 'left',
            }, { id: 'ai-response-viewer' });
        },

        _createViewResponseButton(viewer) {
            const btn = this.createElement('button', {
                background: 'none', border: '1px solid rgba(255, 255, 255, 0.2)',
                color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer',
                fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
                display: 'none', transition: 'all 0.2s ease', marginBottom: '4px',
            }, { id: 'view-raw-response-btn', innerText: 'Ver Resposta da IA' });

            btn.addEventListener('click', () => {
                const isVisible = viewer.style.display === 'block';
                viewer.style.display = isVisible ? 'none' : 'block';
                if (!isVisible) {
                    viewer.innerText = state.lastAiResponse || 'Nenhuma resposta recebida.';
                }
            });

            return btn;
        },

        _createToggleButton() {
            return this.createElement('button', {
                background: 'none', border: '1px solid rgba(255, 255, 255, 0.2)',
                color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer',
                fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
                transition: 'all 0.2s ease', marginBottom: '4px',
            }, { id: 'toggle-ui-btn', innerText: 'Ocultar' });
        },

        _createSolveButton() {
            const btn = this.createElement('button', {
                background: 'linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%)',
                border: 'none', borderRadius: '10px', color: 'white',
                cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                fontSize: '15px', fontWeight: '600', padding: '10px 20px',
                boxShadow: '0 4px 10px rgba(0, 0, 0, 0.2)',
                transition: 'all 0.2s ease', letterSpacing: '0.5px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '8px',
            }, { id: 'ai-solver-button', innerHTML: '✨ Resolver' });

            // Hover effects
            btn.addEventListener('mouseover', () => {
                btn.style.transform = 'translateY(-2px)';
                btn.style.boxShadow = '0 6px 15px rgba(0, 0, 0, 0.3)';
            });
            btn.addEventListener('mouseout', () => {
                btn.style.transform = 'translateY(0)';
                btn.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.2)';
            });
            btn.addEventListener('mousedown', () => {
                btn.style.transform = 'translateY(1px)';
                btn.style.boxShadow = '0 2px 5px rgba(0, 0, 0, 0.15)';
            });
            btn.addEventListener('mouseup', () => {
                btn.style.transform = 'translateY(-2px)';
                btn.style.boxShadow = '0 6px 15px rgba(0, 0, 0, 0.3)';
            });
            btn.addEventListener('click', solveQuestion);

            return btn;
        },

        _createWatermark() {
            const githubIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 3c-.58 0-1.25.27-2 1.5-2.2.86-4.5 1.3-7 1.3-2.5 0-4.7-.44-7-1.3-.75-1.23-1.42-1.5-2-1.5A5.07 5.07 0 0 0 4 4.77 5.44 5.44 0 0 0 2 10.71c0 6.13 3.49 7.34 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>`;

            const wrapper = this.createElement('div', {}, { id: 'mzzvxm-watermark' });
            wrapper.innerHTML = `
                <div style="display:flex;gap:8px;align-items:center;color:rgba(255,255,255,0.7);margin-top:8px;justify-content:flex-end;">
                    <span style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:13px;font-weight:400">@ricinuss</span>
                    <a href="https://github.com/ricinuss" target="_blank" title="GitHub" style="line-height:0;color:inherit;transition:color 0.2s ease">${githubIcon}</a>
                </div>`;

            wrapper.querySelectorAll('a').forEach(link => {
                link.addEventListener('mouseover', () => link.style.color = 'white');
                link.addEventListener('mouseout', () => link.style.color = 'rgba(255,255,255,0.7)');
            });

            return wrapper;
        },

        _setupToggle(toggleBtn, elementIds) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = toggleBtn.innerText === 'Mostrar';
                toggleBtn.innerText = isHidden ? 'Ocultar' : 'Mostrar';

                elementIds.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = isHidden ? '' : 'none';
                });

                // Keep response button hidden if no response yet
                if (isHidden && !state.lastAiResponse) {
                    const respBtn = document.getElementById('view-raw-response-btn');
                    if (respBtn) respBtn.style.display = 'none';
                }
            });
        },

        _makeDraggable(panel) {
            let offsetX = 0, offsetY = 0, isDragging = false;

            panel.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.closest('a')) return;

                isDragging = true;
                const rect = panel.getBoundingClientRect();

                // Convert from bottom/right to top/left positioning
                if (panel.style.bottom || panel.style.right) {
                    panel.style.top = rect.top + 'px';
                    panel.style.left = rect.left + 'px';
                    panel.style.right = 'auto';
                    panel.style.bottom = 'auto';
                }

                offsetX = e.clientX - rect.left;
                offsetY = e.clientY - rect.top;
                panel.style.transition = 'none';
                panel.style.cursor = 'grabbing';
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - panel.offsetWidth));
                const y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - panel.offsetHeight));
                panel.style.top = y + 'px';
                panel.style.left = x + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (!isDragging) return;
                isDragging = false;
                panel.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
                panel.style.cursor = 'default';
            });
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // QUIZ ID DETECTOR
    // ═══════════════════════════════════════════════════════════════

    const QuizIdDetector = {
        init() {
            console.log('[Quizizz Bypass] Quiz ID detector loaded.');

            const id = this._detectFromURL();
            if (id) this._log(id, 'URL');

            if (!state.interceptorsStarted) {
                this._interceptFetch();
                this._interceptXHR();
                this._monitorSPA();
                state.interceptorsStarted = true;
                console.log('[Quizizz Bypass] Network interceptors started.');
            }
        },

        _detectFromURL() {
            const match = window.location.pathname.match(CONFIG.quizIdRegex);
            return match?.[1] || null;
        },

        _log(id, source) {
            if (id === state.quizIdDetected) return;
            state.quizIdDetected = id;
            console.log(
                `[Quizizz Bypass] Quiz ID detected (${source}): %c${id}`,
                'color: #00FF00; font-weight: bold;'
            );
        },

        _interceptFetch() {
            const originalFetch = window.fetch;
            const self = this;

            window.fetch = async function (...args) {
                const [resource] = args;
                if (typeof resource === 'string') {
                    const match = resource.match(CONFIG.quizIdRegex);
                    if (match) self._log(match[1], 'fetch');
                }
                return originalFetch.apply(this, args);
            };
        },

        _interceptXHR() {
            const originalOpen = XMLHttpRequest.prototype.open;
            const self = this;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                if (typeof url === 'string') {
                    const match = url.match(CONFIG.quizIdRegex);
                    if (match) self._log(match[1], 'XHR');
                }
                return originalOpen.call(this, method, url, ...rest);
            };
        },

        _monitorSPA() {
            const self = this;
            const originalPushState = history.pushState;

            history.pushState = function (...args) {
                const result = originalPushState.apply(this, args);
                setTimeout(() => self.init(), 300);
                return result;
            };

            window.addEventListener('popstate', () => {
                setTimeout(() => this.init(), 300);
            });
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════

    setTimeout(() => UI.createPanel(), CONFIG.timeouts.uiDelay);
    QuizIdDetector.init();

})();
