// i18n functionality
'use strict';
// 检测系统语言并返回最合适的语言代码
function getSystemLanguage() {
    const browserLang = navigator.language || 'en';
    const langMap = {
        zh: 'zh',
        'zh-CN': 'zh',
        'zh-TW': 'zh',
        'zh-HK': 'zh',
        'zh-SG': 'zh',
        en: 'en',
        'en-US': 'en',
        'en-GB': 'en',
        'en-CA': 'en',
        'en-AU': 'en',
        ko: 'ko',
        'ko-KR': 'ko',
    };

    if (langMap[browserLang]) {
        return langMap[browserLang];
    }

    const langPrefix = browserLang.split('-')[0];
    if (langMap[langPrefix]) {
        return langMap[langPrefix];
    }

    return 'en';
}

let currentLang = localStorage.getItem('lang') || getSystemLanguage();
let translations = {};
let translation_replacement = {};
let translation_professions = {};

// 支持的语言列表
const supportedLanguages = [
    { code: 'zh', name: '中文' },
    { code: 'en', name: 'English' },
    { code: 'ko', name: '한국어' },
];

async function loadTranslations(lang) {
    try {
        const response = await fetch(`locales/${lang}.json`);
        const data = await response.json();
        translations = data.translations || {};
        translation_replacement = data.replacement || {};
        translation_professions = data.professions || {};
    } catch (error) {
        console.error('Failed to load translations:', error);
    }
}

function updateTexts() {
    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.getAttribute('data-i18n');
        if (translations[key]) {
            if (element.tagName === 'TITLE') {
                element.textContent = translations[key];
            } else {
                element.textContent = translations[key];
            }
        }
    });

    // 更新title属性
    document.querySelectorAll('[data-i18n-title]').forEach((element) => {
        const key = element.getAttribute('data-i18n-title');
        if (translations[key]) {
            element.setAttribute('title', translations[key]);
        }
    });

    // 更新操作按钮文本
    updateActionButtons();
}

async function changeLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('lang', lang);
    await loadTranslations(lang);
    updateTexts();

    // 更新下拉菜单中的active状态
    updateLanguageDropdownActive();

    // 关闭下拉菜单
    hideLanguageDropdown();
}

// 更新下拉菜单中的active状态
function updateLanguageDropdownActive() {
    const dropdown = document.getElementById('langDropdown');
    if (!dropdown) return;

    // 移除所有选项的active类
    const options = dropdown.querySelectorAll('.lang-option');
    options.forEach((option) => {
        option.classList.remove('active');
    });

    // 为当前语言添加active类
    const currentOption = dropdown.querySelector(`[data-lang-code="${currentLang}"]`);
    if (currentOption) {
        currentOption.classList.add('active');
    }
}

// 显示语言下拉菜单
function showLanguageDropdown() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) {
        dropdown.style.display = 'block';
        // 触发重绘以启动动画
        setTimeout(() => {
            dropdown.classList.add('show');
        }, 10);
    }
}

// 隐藏语言下拉菜单
function hideLanguageDropdown() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) {
        dropdown.classList.remove('show');
        setTimeout(() => {
            dropdown.style.display = 'none';
        }, 300); // 与CSS动画时间匹配
    }
}

// 切换语言下拉菜单
function toggleLanguageDropdown() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) {
        if (dropdown.style.display === 'block') {
            hideLanguageDropdown();
        } else {
            showLanguageDropdown();
        }
    }
}

// 点击其他地方关闭下拉菜单
document.addEventListener('click', function (event) {
    const langToggle = document.getElementById('langToggle');
    const dropdown = document.getElementById('langDropdown');

    if (langToggle && dropdown && !langToggle.contains(event.target) && !dropdown.contains(event.target)) {
        hideLanguageDropdown();
    }
});

// Initialize i18n
document.addEventListener('DOMContentLoaded', async () => {
    await loadTranslations(currentLang);
    updateTexts();

    // 创建语言下拉菜单
    createLanguageDropdown();

    const langToggle = document.getElementById('langToggle');
    if (langToggle) {
        langToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleLanguageDropdown();
        });
    }

    // 更新血条监控的无数据提示文本
    const noDataElement = document.querySelector('.no-data div');
    if (noDataElement) {
        noDataElement.innerHTML = translations.noPlayerData || '📭 暂无参战玩家血条数据<br>🗺️ 切线或切图可重新获取血条数据';
    }
});

// 创建语言下拉菜单
function createLanguageDropdown() {
    const langToggle = document.getElementById('langToggle');
    if (!langToggle) return;

    // 创建下拉菜单容器
    const dropdown = document.createElement('div');
    dropdown.id = 'langDropdown';
    dropdown.className = 'lang-dropdown';

    // 创建语言选项
    supportedLanguages.forEach((lang) => {
        const option = document.createElement('div');
        option.className = 'lang-option';
        option.setAttribute('data-lang-code', lang.code);
        if (lang.code === currentLang) {
            option.classList.add('active');
        }
        option.textContent = lang.name;
        option.addEventListener('click', () => {
            changeLanguage(lang.code);
        });
        dropdown.appendChild(option);
    });

    // 将下拉菜单插入到按钮后面
    langToggle.parentNode.insertBefore(dropdown, langToggle.nextSibling);
}

// 更新操作按钮文本
function updateActionButtons() {
    // 更新复制数据按钮
    const copyButtons = document.querySelectorAll('.copy-btn');
    copyButtons.forEach((button) => {
        const icon = button.querySelector('.icon');
        if (icon) {
            button.innerHTML = `<i class="icon">📋</i> ${translations.copyData || '复制数据'}`;
        }
    });

    // 更新技能分析按钮
    const skillButtons = document.querySelectorAll('.skill-btn');
    skillButtons.forEach((button) => {
        const icon = button.querySelector('.icon');
        if (icon) {
            button.innerHTML = `<i class="icon">📊</i> ${translations.skillAnalysisBtn || '技能分析'}`;
        }
    });
}

function getTranslationByReplace(chi) {
    return translation_replacement[chi] || chi;
}

function getTranslatedProfession(profession) {
    const professions = profession.split('-');
    for (let i = 0; i < professions.length; i++) {
        professions[i] = translation_professions[professions[i]] || professions[i];
    }
    return professions.join('-');
}
