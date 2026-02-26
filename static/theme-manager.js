/**
 * Theme and UI Manager
 * Handles dark mode toggling with system preference support and collapsible sections
 */

class ThemeManager {
    constructor() {
        this.themeKey = 'zwo-camera-theme-preference';
        this.collapsedSectionsKey = 'zwo-camera-collapsed-sections';
        this.init();
    }

    init() {
        this.setupDarkModeToggle();
        this.setupCollapsibleSections();
        this.setupSystemThemeListener();
        this.loadSavedTheme();
        this.loadCollapsedState();
    }

    setupDarkModeToggle() {
        const toggleBtn = document.getElementById('darkModeToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleDarkMode());
        }
    }

    setupCollapsibleSections() {
        const collapsibleSections = document.querySelectorAll('.collapsible');
        collapsibleSections.forEach(section => {
            const collapseBtn = section.querySelector('.collapse-btn');
            if (collapseBtn) {
                collapseBtn.addEventListener('click', () => this.toggleCollapse(section));
            }
        });
    }

    setupSystemThemeListener() {
        // Listen for system theme changes
        if (window.matchMedia) {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.addListener(() => {
                this.updateTheme();
            });
        }
    }

    toggleDarkMode() {
        const body = document.body;
        const savedTheme = this.getSavedTheme();
        let newTheme;

        if (savedTheme === 'auto') {
            // If currently auto, switch to manual override
            const systemPrefersDark = this.getSystemPreference();
            newTheme = systemPrefersDark ? 'light' : 'dark';
        } else if (savedTheme === 'dark') {
            newTheme = 'light';
        } else if (savedTheme === 'light') {
            newTheme = 'auto';
        } else {
            // Default case - switch to opposite of current effective theme
            const currentlyDark = this.isCurrentlyDark();
            newTheme = currentlyDark ? 'light' : 'dark';
        }

        this.setTheme(newTheme);
        console.log(`Theme switched to: ${newTheme}`);
    }

    setTheme(theme) {
        const body = document.body;
        
        // Clear existing theme classes
        body.classList.remove('dark-mode', 'light-mode');
        
        if (theme === 'dark') {
            body.classList.add('dark-mode');
        } else if (theme === 'light') {
            body.classList.add('light-mode');
        }
        // For 'auto', neither class is added, letting CSS prefers-color-scheme take effect
        
        // Save preference
        localStorage.setItem(this.themeKey, theme);
        
        // Update toggle button
        this.updateToggleButton();
    }

    updateTheme() {
        const savedTheme = this.getSavedTheme();
        this.setTheme(savedTheme);
    }

    updateToggleButton() {
        const toggleBtn = document.getElementById('darkModeToggle');
        if (!toggleBtn) return;

        const savedTheme = this.getSavedTheme();
        const currentlyDark = this.isCurrentlyDark();

        if (savedTheme === 'auto') {
            toggleBtn.textContent = '🌓'; // Half moon for auto
            toggleBtn.title = 'Theme: Auto (following system)';
        } else if (currentlyDark) {
            toggleBtn.textContent = '☀️'; // Sun when dark (click to go light)
            toggleBtn.title = 'Theme: Dark (click for light)';
        } else {
            toggleBtn.textContent = '🌙'; // Moon when light (click to go dark)
            toggleBtn.title = 'Theme: Light (click for dark)';
        }
    }

    getSavedTheme() {
        return localStorage.getItem(this.themeKey) || 'auto';
    }

    getSystemPreference() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    isCurrentlyDark() {
        const body = document.body;
        if (body.classList.contains('dark-mode')) return true;
        if (body.classList.contains('light-mode')) return false;
        // If no explicit class, follow system preference
        return this.getSystemPreference();
    }

    loadSavedTheme() {
        const savedTheme = this.getSavedTheme();
        this.setTheme(savedTheme);
    }

    toggleCollapse(section) {
        const isCollapsed = section.classList.toggle('collapsed');
        const sectionId = this.getSectionId(section);
        
        // Save collapsed state
        const collapsedSections = this.getCollapsedSections();
        if (isCollapsed) {
            collapsedSections.add(sectionId);
        } else {
            collapsedSections.delete(sectionId);
        }
        localStorage.setItem(this.collapsedSectionsKey, JSON.stringify([...collapsedSections]));
    }

    getSectionId(section) {
        // Create a unique ID based on the section's content
        const title = section.querySelector('.collapse-btn span')?.textContent;
        return title ? title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() : 'unknown';
    }

    getCollapsedSections() {
        const stored = localStorage.getItem(this.collapsedSectionsKey);
        return new Set(stored ? JSON.parse(stored) : []);
    }

    loadCollapsedState() {
        const collapsedSections = this.getCollapsedSections();
        const sections = document.querySelectorAll('.collapsible');
        
        sections.forEach(section => {
            const sectionId = this.getSectionId(section);
            if (collapsedSections.has(sectionId)) {
                section.classList.add('collapsed');
            }
        });
    }

    // Public API for external access
    isDarkMode() {
        return this.isCurrentlyDark();
    }

    enableDarkMode() {
        this.setTheme('dark');
    }

    disableDarkMode() {
        this.setTheme('light');
    }

    setAutoMode() {
        this.setTheme('auto');
    }

    getCurrentTheme() {
        return this.getSavedTheme();
    }
}

// Initialize theme manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
});

// Export for external access
window.ThemeManager = ThemeManager;