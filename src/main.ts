import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Configuration {
  id: string;
  name: string;
  url?: string; // Made optional for custom configurations
  useDefaultAuth: boolean;
  headers: Array<{ name: string; value: string }>;
  databaseName?: string;
  gcpSecretName?: string; // Para compatibilidade com configurações salvas antigas
  created_by?: string; // Track creator for deletion permissions
  isPrivate?: boolean; // NEW - default true for new configs
  isInDatabase?: boolean; // NEW - tracks if config exists in DB
}

interface CustomEndpoint {
  id: string;
  config_id: string;
  name: string;
  description?: string;
  base_url: string;
  endpoint_path: string;
  method: string;
  query_params: QueryParam[];
  example_body?: string;
  example_result?: string;
  created_by: string;
}

interface QueryParam {
  name: string;
  type: string;
  required: boolean;
  default?: string;
}

interface TestResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
}

interface SavedValueSet {
  id: string;
  name: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  body: string;
  createdAt: string;
}

interface EndpointSavedSets {
  [configId: string]: {
    [method: string]: {
      [path: string]: SavedValueSet[];
    };
  };
}

interface SavedResult {
  id: string;
  name: string;
  endpoint: {
    method: string;
    path: string;
    configId: string;
  };
  request: {
    pathParams: Record<string, string>;
    queryParams: Record<string, string>;
    body: string;
    sentUuid?: string; // UUID enviado no header da requisição
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: any;
  };
  timestamp: string;
  storageLocation?: 'local' | 'database';
  userAccount?: string;
}

interface SavedResults {
  [configId: string]: SavedResult[];
}

class ConfigManager {
  private configs: Configuration[] = [];
  private editingId: string | null = null;
  private savedValueSets: EndpointSavedSets = {};
  private customSavedValueSets: { [configId: string]: { [endpointId: string]: SavedValueSet[] } } = {};
  private savedResults: SavedResults = {};
  private readonly STORAGE_KEY = 'openapiui-configurations';
  private readonly SAVED_SETS_KEY = 'openapiui-saved-sets';
  private readonly CUSTOM_SAVED_SETS_KEY = 'openapiui-custom-saved-sets';
  private readonly SAVED_RESULTS_KEY = 'openapiui-saved-results';
  private readonly THEME_KEY = 'openapiui-theme';
  private readonly FONT_SIZE_KEY = 'openapiui-font-size';
  private readonly DATABASE_SECRETS_KEY = 'openapiui-database-secrets';
  private defaultBodyValues = new Map<string, string>();
  private readonly APP_VERSION = '0.1.9'; // Versão atual do aplicativo
  private cachedGcloudUser: string | null = null; // Cache para usuário gcloud
  private databaseError: string | null = null; // Armazena erro de acesso ao banco de dados
  private pendingConfig: Configuration | null = null; // Configuração pendente de sincronização
  private databaseSecrets: string[] = []; // Lista de nomes de secrets de banco de dados

  private elements = {
    configForm: document.querySelector("#config-form") as HTMLFormElement,
    nameInput: document.querySelector("#config-name") as HTMLInputElement,
    urlInput: document.querySelector("#config-url") as HTMLInputElement,
    databaseInput: document.querySelector("#config-secret") as HTMLInputElement,
    authCheckbox: document.querySelector("#config-auth") as HTMLInputElement,
    privateCheckbox: document.querySelector("#config-private") as HTMLInputElement,
    headersList: document.querySelector("#headers-list") as HTMLDivElement,
    addHeaderBtn: document.querySelector("#add-header-btn") as HTMLButtonElement,
    submitBtn: document.querySelector("#submit-btn") as HTMLButtonElement,
    cancelBtn: document.querySelector("#cancel-btn") as HTMLButtonElement,
    configsList: document.querySelector("#configs-list") as HTMLDivElement,
    configSelect: document.querySelector("#config-select") as HTMLSelectElement,
    fontSizeSelect: document.querySelector("#font-size-select") as HTMLSelectElement,
    reloadSpecBtn: document.querySelector("#reload-spec-btn") as HTMLButtonElement,
    editConfigsBtn: document.querySelector("#edit-configs-btn") as HTMLButtonElement,
    devtoolsBtn: document.querySelector("#devtools-btn") as HTMLButtonElement,
    themeToggleBtn: document.querySelector("#theme-toggle-btn") as HTMLButtonElement,
    aboutBtn: document.querySelector("#about-btn") as HTMLButtonElement,
    extrasMenu: document.querySelector(".extras-menu") as HTMLDivElement,
    extrasMenuBtn: document.querySelector("#extras-menu-btn") as HTMLButtonElement,
    extrasDropdown: document.querySelector("#extras-dropdown") as HTMLDivElement,
    configModal: document.querySelector("#config-modal") as HTMLDivElement,
    closeModalBtn: document.querySelector("#close-modal") as HTMLButtonElement,
    aboutModal: document.querySelector("#about-modal") as HTMLDivElement,
    closeAboutModalBtn: document.querySelector("#close-about-modal") as HTMLButtonElement,
    welcomeScreen: document.querySelector("#welcome-screen") as HTMLDivElement,
    customEndpointModal: document.querySelector("#custom-endpoint-modal") as HTMLDivElement,
    closeCustomEndpointModalBtn: document.querySelector("#close-custom-endpoint-modal") as HTMLButtonElement,
    customEndpointForm: document.querySelector("#custom-endpoint-form") as HTMLFormElement,
    customEndpointName: document.querySelector("#custom-endpoint-name") as HTMLInputElement,
    customEndpointDescription: document.querySelector("#custom-endpoint-description") as HTMLInputElement,
    customEndpointBaseUrl: document.querySelector("#custom-endpoint-base-url") as HTMLInputElement,
    customEndpointPath: document.querySelector("#custom-endpoint-path") as HTMLInputElement,
    customEndpointMethod: document.querySelector("#custom-endpoint-method") as HTMLSelectElement,
    customEndpointQueryParams: document.querySelector("#custom-endpoint-query-params") as HTMLDivElement,
    addQueryParamBtn: document.querySelector("#add-query-param-btn") as HTMLButtonElement,
    customEndpointExampleBody: document.querySelector("#custom-endpoint-example-body") as HTMLTextAreaElement,
    customEndpointExampleResult: document.querySelector("#custom-endpoint-example-result") as HTMLTextAreaElement,
    saveCustomEndpointBtn: document.querySelector("#save-custom-endpoint-btn") as HTMLButtonElement,
    cancelCustomEndpointBtn: document.querySelector("#cancel-custom-endpoint-btn") as HTMLButtonElement,
    customEndpointId: document.querySelector("#custom-endpoint-id") as HTMLInputElement,
    customEndpointConfigId: document.querySelector("#custom-endpoint-config-id") as HTMLInputElement,
    customEndpointModalTitle: document.querySelector("#custom-endpoint-modal-title") as HTMLHeadingElement,
    syncModal: document.querySelector("#sync-modal") as HTMLDivElement,
    syncValueSetsCheckbox: document.querySelector("#sync-value-sets") as HTMLInputElement,
    syncTestResultsCheckbox: document.querySelector("#sync-test-results") as HTMLInputElement,
    syncCustomEndpointsCheckbox: document.querySelector("#sync-custom-endpoints") as HTMLInputElement,
    confirmSyncBtn: document.querySelector("#confirm-sync-btn") as HTMLButtonElement,
    cancelSyncBtn: document.querySelector("#cancel-sync-btn") as HTMLButtonElement,
    closeSyncModalBtn: document.querySelector("#close-sync-modal") as HTMLButtonElement,
    databaseSecretInput: document.querySelector("#database-secret-input") as HTMLInputElement,
    addDatabaseSecretBtn: document.querySelector("#add-database-secret-btn") as HTMLButtonElement,
    databaseSecretsList: document.querySelector("#database-secrets-list") as HTMLDivElement,
  };

  async init() {
    await Promise.all([
      this.loadConfigs(),
      this.loadSavedValueSets(),
      this.loadCustomSavedValueSets(),
      this.loadSavedResults(),
      this.loadTheme(),
      this.loadFontSize(),
      this.loadGcloudUser(),
      this.loadDatabaseSecrets()
    ]);
    this.setupEventListeners();
    this.updateConfigSelect();
    this.renderConfigs();
    this.renderDatabaseSecrets();

    // Atualizar título da janela ao iniciar
    await this.updateWindowTitle();
  }

  private setupEventListeners() {
    // Event delegation for global-history-btn (works for both regular and custom configs)
    document.body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('global-history-btn')) {
        const configId = target.dataset.configId;
        if (configId) {
          this.showHistoryModal(configId);
        }
      }
    });

    // Event delegation for edit-config-btn (edit selected config)
    document.body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const editBtn = target.closest('.edit-config-btn');
      if (editBtn) {
        const configId = (editBtn as HTMLElement).dataset.configId;
        if (configId) {
          this.editConfig(configId);
        }
      }
    });

    // Form de configuração
    this.elements.configForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.handleSubmit();
    });

    this.elements.cancelBtn.addEventListener("click", () => {
      this.resetForm();
    });

    // Botão de adicionar header
    this.elements.addHeaderBtn.addEventListener("click", () => {
      this.addHeaderField();
    });

    // Modal
    this.elements.editConfigsBtn.addEventListener("click", () => {
      this.resetForm();
      this.showModal();
    });

    this.elements.devtoolsBtn.addEventListener("click", async () => {
      try {
        await invoke('toggle_devtools');
      } catch (error) {
        console.error('Failed to toggle devtools:', error);
      }
    });

    this.elements.themeToggleBtn.addEventListener("click", () => {
      this.toggleTheme();
    });

    // Menu de Opções Extras
    this.elements.extrasMenuBtn.addEventListener("click", () => {
      this.toggleExtrasDropdown();
    });

    this.elements.fontSizeSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      const fontSize = parseFloat(target.value);
      this.setFontSize(fontSize);
    });

    // Modal Sobre
    this.elements.aboutBtn.addEventListener("click", () => {
      this.showAboutModal();
    });

    this.elements.closeAboutModalBtn.addEventListener("click", () => {
      this.hideAboutModal();
    });

    this.elements.closeModalBtn.addEventListener("click", () => {
      this.hideModal();
    });

    // Custom endpoint modal event listeners
    this.elements.closeCustomEndpointModalBtn.addEventListener("click", () => {
      this.hideCustomEndpointModal();
    });

    this.elements.customEndpointModal.addEventListener("click", (e) => {
      if (e.target === this.elements.customEndpointModal) {
        this.hideCustomEndpointModal();
      }
    });

    this.elements.cancelCustomEndpointBtn.addEventListener("click", () => {
      this.hideCustomEndpointModal();
    });

    // Sync modal event listeners
    this.elements.confirmSyncBtn.addEventListener("click", () => {
      this.handleSyncConfirm();
    });

    this.elements.cancelSyncBtn.addEventListener("click", () => {
      this.handleSyncCancel();
    });

    this.elements.closeSyncModalBtn.addEventListener("click", () => {
      this.hideSyncModal();
    });

    // Database secrets management
    this.elements.addDatabaseSecretBtn.addEventListener("click", () => {
      this.addDatabaseSecret();
    });

    this.elements.customEndpointForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.handleCustomEndpointSubmit();
    });

    this.elements.addQueryParamBtn.addEventListener("click", () => {
      this.addQueryParamField();
    });

    // Select de configurações
    this.elements.configSelect.addEventListener("change", (e) => {
      const selectedId = (e.target as HTMLSelectElement).value;
      this.handleConfigSelection(selectedId);
    });

    // Botão de recarregar especificação
    this.elements.reloadSpecBtn.addEventListener("click", () => {
      const selectedId = this.elements.configSelect.value;
      if (selectedId) {
        this.handleConfigSelection(selectedId);
      }
    });

    // Event delegation para botões de reset
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('reset-btn')) {
        const resetType = target.dataset.reset;
        if (resetType) {
          this.handleReset(resetType);
        }
      }
    });

    // Fechar modal clicando fora
    this.elements.configModal.addEventListener("click", (e) => {
      if (e.target === this.elements.configModal) {
        this.hideModal();
      }
    });

    // Fechar modal Sobre clicando fora
    this.elements.aboutModal.addEventListener("click", (e) => {
      if (e.target === this.elements.aboutModal) {
        this.hideAboutModal();
      }
    });

    // Fechar modais com a tecla ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.handleEscapeKey();
      }
    });

    // Fechar dropdown clicando fora
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!this.elements.extrasMenu.contains(target)) {
        this.elements.extrasDropdown.classList.add('hidden');
      }
    });
  }

  private async loadGcloudUser() {
    try {
      this.cachedGcloudUser = await invoke<string>('get_gcloud_account');
    } catch (error) {
      console.warn('Could not load gcloud user on startup:', error);
      this.cachedGcloudUser = null;
    }
  }

  private async loadDatabaseSecrets() {
    try {
      const stored = await invoke<any>('load_app_data', { key: this.DATABASE_SECRETS_KEY });
      if (stored && Array.isArray(stored)) {
        this.databaseSecrets = stored;
      } else {
        this.databaseSecrets = [];
      }
    } catch (error) {
      console.error('Failed to load database secrets:', error);
      this.databaseSecrets = [];
    }
  }

  private async saveDatabaseSecrets() {
    try {
      await invoke('save_app_data', {
        key: this.DATABASE_SECRETS_KEY,
        value: this.databaseSecrets
      });
    } catch (error) {
      console.error('Failed to save database secrets:', error);
    }
  }

  private async addDatabaseSecret() {
    const secretName = this.elements.databaseSecretInput.value.trim();
    if (!secretName) {
      this.showToast('Por favor, digite um nome para o secret.', 'error');
      return;
    }

    if (this.databaseSecrets.includes(secretName)) {
      this.showToast('Este secret já foi adicionado.', 'error');
      return;
    }

    this.databaseSecrets.push(secretName);
    await this.saveDatabaseSecrets();
    this.renderDatabaseSecrets();
    this.elements.databaseSecretInput.value = '';
    this.showToast('Secret adicionado com sucesso!', 'success');
    
    // Reload configurations from all databases
    await this.loadConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private async removeDatabaseSecret(secretName: string) {
    const confirmed = await this.showConfirmDialog(`Tem certeza que deseja remover o secret "${secretName}"?`);
    if (!confirmed) {
      return;
    }

    this.databaseSecrets = this.databaseSecrets.filter(s => s !== secretName);
    await this.saveDatabaseSecrets();
    this.renderDatabaseSecrets();
    this.showToast('Secret removido com sucesso!', 'success');
    
    // Reload configurations from remaining databases
    await this.loadConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private renderDatabaseSecrets() {
    if (this.databaseSecrets.length === 0) {
      this.elements.databaseSecretsList.innerHTML = '<p class="empty-state">Nenhum secret adicionado ainda.</p>';
      return;
    }

    this.elements.databaseSecretsList.innerHTML = this.databaseSecrets.map(secret => `
      <div class="database-secret-item">
        <span>${this.escapeHtml(secret)}</span>
        <button class="remove-secret-btn" data-secret="${this.escapeHtml(secret)}">Remover</button>
      </div>
    `).join('');

    // Add event listeners for remove buttons
    document.querySelectorAll('.remove-secret-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const secret = (e.target as HTMLElement).dataset.secret;
        if (secret) {
          this.removeDatabaseSecret(secret);
        }
      });
    });
  }

  private async loadConfigs() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.STORAGE_KEY });
        if (stored) {
          this.configs = stored;
          
          // Migrar configurações antigas que usam gcpSecretName
          this.configs = this.configs.map(config => {
            if (config.gcpSecretName && !config.databaseName) {
              return {
                ...config,
                databaseName: config.gcpSecretName,
                gcpSecretName: undefined // Limpar campo antigo
              };
            }
            // Default isPrivate to true for existing configs
            if (config.isPrivate === undefined) {
              return {
                ...config,
                isPrivate: true
              };
            }
            return config;
          });
          
          // Salvar configurações migradas
          await this.saveConfigs();
        } else {
          this.configs = [];
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (stored) {
          this.configs = JSON.parse(stored);
          
          // Migrar configurações antigas
          this.configs = this.configs.map(config => {
            if (config.gcpSecretName && !config.databaseName) {
              return {
                ...config,
                databaseName: config.gcpSecretName,
                gcpSecretName: undefined
              };
            }
            // Default isPrivate to true for existing configs
            if (config.isPrivate === undefined) {
              return {
                ...config,
                isPrivate: true
              };
            }
            return config;
          });
          
          // Migrar para app_data_dir
          await this.saveConfigs();
        } else {
          this.configs = [];
        }
      }

      // Load online configs from PostgreSQL for each unique databaseName
      const uniqueDatabaseNames = new Set<string>();
      this.configs.forEach(config => {
        if (config.databaseName) {
          uniqueDatabaseNames.add(config.databaseName);
        }
      });

      // If no database names found in local configs, use the databaseSecrets list
      // This allows loading configs from database even if no local configs exist
      if (uniqueDatabaseNames.size === 0 && this.databaseSecrets.length > 0) {
        this.databaseSecrets.forEach(dbName => uniqueDatabaseNames.add(dbName));
        console.log('No database names in local configs, using databaseSecrets list:', Array.from(uniqueDatabaseNames));
      }

      console.log('Loading online configs from databases:', Array.from(uniqueDatabaseNames));

      for (const dbName of uniqueDatabaseNames) {
        try {
          console.log(`Loading configs from database: ${dbName}`);
          const onlineConfigs = await invoke<any>('list_postgres_configs', { secretName: dbName });
          console.log(`Loaded ${onlineConfigs?.length || 0} configs from database ${dbName}`);
          
          if (onlineConfigs && Array.isArray(onlineConfigs)) {
            // Merge online configs with local configs
            onlineConfigs.forEach((onlineConfig: Configuration) => {
              console.log('Processing online config:', onlineConfig.id, onlineConfig.name);
              const existingIndex = this.configs.findIndex(c => c.id === onlineConfig.id);
              if (existingIndex !== -1) {
                // Update existing config with database info
                this.configs[existingIndex].isInDatabase = true;
                this.configs[existingIndex].isPrivate = onlineConfig.isPrivate;
                console.log('Updated existing config with database info');
              } else {
                // Add new config from database
                onlineConfig.isInDatabase = true;
                this.configs.push(onlineConfig);
                console.log('Added new config from database');
              }
            });
          }
        } catch (error) {
          console.error(`Failed to load online configs from database ${dbName}:`, error);
          // Fallback to local configs only
        }
      }

      console.log('Total configs after merge:', this.configs.length);
    } catch (error) {
      console.error('Failed to load configs:', error);
      this.configs = [];
    }
  }

  private async saveConfigs() {
    try {
      await invoke('save_app_data', { 
        key: this.STORAGE_KEY, 
        value: this.configs 
      });
    } catch (error) {
      console.error('Failed to save configurations to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.configs, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private async loadSavedValueSets() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.SAVED_SETS_KEY });
        if (stored) {
          this.savedValueSets = stored;
        } else {
          this.savedValueSets = {};
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.SAVED_SETS_KEY);
        if (stored) {
          this.savedValueSets = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveSavedValueSets();
        } else {
          this.savedValueSets = {};
        }
      }
    } catch (error) {
      console.error('Failed to load saved value sets:', error);
      this.savedValueSets = {};
    }
  }

  private async saveSavedValueSets() {
    try {
      await invoke('save_app_data', { 
        key: this.SAVED_SETS_KEY, 
        value: this.savedValueSets 
      });
    } catch (error) {
      console.error('Failed to save saved value sets to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.SAVED_SETS_KEY, JSON.stringify(this.savedValueSets, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private async loadCustomSavedValueSets() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.CUSTOM_SAVED_SETS_KEY });
        if (stored) {
          this.customSavedValueSets = stored;
        } else {
          this.customSavedValueSets = {};
        }
      } catch (appDataError) {
        console.warn('Failed to load custom saved sets from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.CUSTOM_SAVED_SETS_KEY);
        if (stored) {
          this.customSavedValueSets = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveCustomSavedValueSets();
        } else {
          this.customSavedValueSets = {};
        }
      }
    } catch (error) {
      console.error('Failed to load custom saved value sets:', error);
      this.customSavedValueSets = {};
    }
  }

  private async saveCustomSavedValueSets() {
    try {
      await invoke('save_app_data', { 
        key: this.CUSTOM_SAVED_SETS_KEY, 
        value: this.customSavedValueSets 
      });
    } catch (error) {
      console.error('Failed to save custom saved value sets to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.CUSTOM_SAVED_SETS_KEY, JSON.stringify(this.customSavedValueSets, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private async loadSavedResults() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.SAVED_RESULTS_KEY });
        if (stored) {
          this.savedResults = stored;
        } else {
          this.savedResults = {};
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.SAVED_RESULTS_KEY);
        if (stored) {
          this.savedResults = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveSavedResults();
        } else {
          this.savedResults = {};
        }
      }
    } catch (error) {
      console.error('Failed to load saved results:', error);
      this.savedResults = {};
    }
  }

  private async saveSavedResults() {
    try {
      await invoke('save_app_data', { 
        key: this.SAVED_RESULTS_KEY, 
        value: this.savedResults 
      });
    } catch (error) {
      console.error('Failed to save saved results to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.SAVED_RESULTS_KEY, JSON.stringify(this.savedResults, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private updateConfigSelect() {
    this.elements.configSelect.innerHTML = '<option value="">Selecione uma configuração</option>';
    
    this.configs.forEach(config => {
      const option = document.createElement('option');
      option.value = config.id;
      // Add prefix based on config location
      const prefix = config.isInDatabase && config.databaseName
        ? `[DB][${this.escapeHtml(config.databaseName)}] `
        : '[L] ';
      option.textContent = prefix + config.name;
      this.elements.configSelect.appendChild(option);
    });
  }

  private async handleConfigSelection(configId: string) {
    // Atualizar título da janela
    await this.updateWindowTitle();
    
    // Resetar erro de banco de dados ao selecionar nova configuração
    this.databaseError = null;
    
    if (!configId) {
      this.elements.welcomeScreen.style.display = 'block';
      this.elements.welcomeScreen.innerHTML = `
        <h2>Bem-vindo ao EasyOpenAPI</h2>
        <p>Selecione uma configuração no menu superior ou clique em "Editar Configurações" para gerenciar suas APIs.</p>
      `;
      this.elements.reloadSpecBtn.disabled = true;
      return;
    }

    this.elements.reloadSpecBtn.disabled = false;

    const config = this.configs.find(c => c.id === configId);
    if (config) {
      // Verificar se há erro de secret antes de renderizar
      let databaseStatusMessage = '';
      if (config.databaseName) {
        try {
          // Tentar acessar o banco para verificar se o secret está acessível
          await invoke('list_postgres_results', {
            secretName: config.databaseName,
            configId
          });
          databaseStatusMessage = `<div class="database-success">✅ Secret OK e conexão bem-sucedida</div>`;
        } catch (error) {
          console.error('Failed to load database results:', error);
          const errorMessage = String(error);
          
          if (errorMessage.includes('NOT_FOUND') && errorMessage.includes('Secret')) {
            this.databaseError = `Erro ao acessar secret "${config.databaseName}": Secret não encontrado ou sem permissão. Verifique a configuração no GCP.`;
            databaseStatusMessage = `<div class="database-error">⚠️ ${this.escapeHtml(this.databaseError)}</div>`;
          } else if (errorMessage.includes('Failed to connect to PostgreSQL') || 
                     errorMessage.includes('password authentication failed') ||
                     errorMessage.includes('connection') || 
                     errorMessage.includes('authentication')) {
            // Extrair mensagem mais amigável do erro
            let friendlyMessage = errorMessage;
            if (errorMessage.includes('usuário') || errorMessage.includes('senha incorretos')) {
              friendlyMessage = 'Credenciais de acesso incorretas';
            } else if (errorMessage.includes('connection refused')) {
              friendlyMessage = 'Servidor PostgreSQL não está acessível';
            } else if (errorMessage.includes('does not exist')) {
              friendlyMessage = 'Banco de dados não encontrado';
            } else if (errorMessage.includes('timeout')) {
              friendlyMessage = 'Timeout na conexão';
            }
            
            this.databaseError = `Erro de conexão PostgreSQL "${config.databaseName}": ${friendlyMessage}`;
            databaseStatusMessage = `<div class="database-error">❌ ${this.escapeHtml(this.databaseError)}</div>`;
          } else {
            // Truncar mensagem muito longa para exibição
            const displayMessage = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
            this.databaseError = `Erro ao acessar banco de dados "${config.databaseName}": ${displayMessage}`;
            databaseStatusMessage = `<div class="database-error">⚠️ ${this.escapeHtml(this.databaseError)}</div>`;
          }
        }
      }

      this.elements.welcomeScreen.innerHTML = `
        <div class="selected-config">
          <div class="config-header">
            <div class="config-info">
              <h3>${this.escapeHtml(config.name)}</h3>
              <p><strong>URL:</strong> ${config.url ? this.escapeHtml(config.url) : 'Configuração Customizada (sem URL)'}</p>
              <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'gcloud' : 'não'}</p>
              ${config.databaseName ? `
                <div><strong>Secret do BD:</strong> <span>${this.escapeHtml(config.databaseName)}</span> ${databaseStatusMessage}</div>
                
              ` : ''}
            </div>
            <button 
              class="edit-config-btn" 
              data-config-id="${config.id}"
              title="Editar configuração"
            >
              ✏️ Editar
            </button>
            <button 
              class="global-history-btn" 
              data-config-id="${config.id}"
              title="Ver histórico de resultados"
            >
              📋 Histórico
            </button>
          </div>
          <div id="openapi-content" class="openapi-content">
            <p>Carregando especificação OpenAPI...</p>
          </div>
        </div>
      `;

      // Se for configuração customizada sem URL, carregar endpoints customizados
      if (!config.url) {
        await this.loadCustomEndpoints(config);
      } else {
        // Carregar o OpenAPI JSON
        await this.loadOpenApiSpec(config);
      }
    }
  }

  private async loadCustomEndpoints(config: Configuration) {
    try {
      const endpoints = await invoke<CustomEndpoint[]>('list_custom_endpoints', { 
        configId: config.id,
        databaseName: config.databaseName
      });
      await this.displayCustomEndpoints(config, endpoints);
    } catch (error) {
      console.error('Failed to load custom endpoints:', error);
      const openApiContent = document.getElementById('openapi-content') as HTMLDivElement;
      openApiContent.innerHTML = `
        <div class="error-state">
          <p>Erro ao carregar endpoints customizados: ${this.escapeHtml(String(error))}</p>
        </div>
      `;
    }
  }

  private async loadOpenApiSpec(config: Configuration) {
    const openApiContent = document.getElementById('openapi-content') as HTMLDivElement;
    
    try {
      const fullUrl = `${config.url}/openapi.json`;

      // Tentar usar o proxy Tauri primeiro (evita CORS)
      let openApiSpec: any;
      
      try {
        openApiSpec = await invoke('fetch_openapi_spec', {
          url: fullUrl,
          useAuth: config.useDefaultAuth
        });
      } catch (tauriError) {
        console.warn('Tauri proxy failed, falling back to fetch:', tauriError);
        
        // Fallback para fetch normal (com CORS)
        const headers: HeadersInit = {
          'Content-Type': 'application/json',
        };

        // Adicionar headers de autenticação se necessário
        if (config.useDefaultAuth) {
          try {
            const token = await this.getGcloudToken();
            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
              headers['TokenPortal'] = token; // Header adicional conforme solicitado
            }
          } catch (error) {
            console.error('Failed to get gcloud token:', error);
            openApiContent.innerHTML = `
              <div class="error-message">
                <h4>Erro de Autenticação</h4>
                <p>Não foi possível obter o token do gcloud. Verifique se você está autenticado.</p>
                <details>
                  <summary>Detalhes do erro</summary>
                  <pre>${this.escapeHtml(String(error))}</pre>
                </details>
              </div>
            `;
            return;
          }
        }

        // Validar URL
        try {
          new URL(fullUrl);
        } catch (urlError) {
          throw new Error(`URL inválida: ${fullUrl}. Erro: ${String(urlError)}`);
        }

        const response = await fetch(fullUrl, {
          method: 'GET',
          headers: headers,
          mode: 'cors',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        openApiSpec = await response.json();
      }

      this.displayOpenApiSpec(openApiSpec, openApiContent);

    } catch (error) {
      console.error('Failed to load OpenAPI spec:', error);
      this.displayError(error, openApiContent);
    }
  }

  private async getGcloudToken(): Promise<string> {
    try {
      const token = await invoke<string>('get_gcloud_token');
      return token;
    } catch (error) {
      throw new Error(`Failed to get gcloud token: ${String(error)}`);
    }
  }

  private displayOpenApiSpec(spec: any, container: HTMLDivElement) {
    // Obter o ID da configuração atual antes de usá-lo
    const currentConfigId = this.getCurrentConfigId();
    
    const specHtml = `
      <div class="openapi-spec">
        <h4>Especificação OpenAPI</h4>
        <div class="spec-info">
          <p><strong>Título:</strong> ${this.escapeHtml(spec.info?.title || 'N/A')}</p>
          <p><strong>Versão:</strong> ${this.escapeHtml(spec.info?.version || 'N/A')}</p>
          <p><strong>Descrição:</strong> ${this.escapeHtml(spec.info?.description || 'N/A')}</p>
        </div>
        
        ${spec.paths ? `
          <div class="paths-section">
            <h5>Endpoints Disponíveis:</h5>
            <div class="paths-list">
              ${Object.entries(spec.paths)
                .map(([path, methods]: [string, any]) => {
                  // Filtrar apenas os métodos que não têm "summary": "Root"
                  const filteredMethods = Object.entries(methods).filter(([, details]: [string, any]) => details.summary !== 'Root');
                  
                  // Criar itens individuais para cada método
                  return filteredMethods.map(([method, details]: [string, any]) => `
                    <div class="path-item method-item">
                      <div class="path-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <div class="endpoint-info">
                          <span class="method-type ${method.toLowerCase()}">${method.toUpperCase()}</span>
                          <h6>${this.escapeHtml(path)}</h6>
                          <span class="method-summary">${this.escapeHtml(details.summary || details.description || 'No description')}</span>
                        </div>
                        <span class="expand-icon">▶</span>
                      </div>
                      <div class="path-content">
                        <div class="method-test">
                          ${this.generateTestInterface(method, details, path, spec, currentConfigId)}
                        </div>
                      </div>
                    </div>
                  `).join('');
                }).join('')}
            </div>
          </div>
        ` : ''}
        
        <details class="raw-json">
          <summary>Ver JSON Raw</summary>
          <pre><code>${this.escapeHtml(JSON.stringify(spec, null, 2))}</code></pre>
        </details>
      </div>
    `;
    
    container.innerHTML = specHtml;
    this.attachTestEventListeners();
    
    // Atualizar selects de conjuntos salvos para todos os endpoints
    if (currentConfigId && spec.paths) {
      Object.entries(spec.paths).forEach(([path, methods]: [string, any]) => {
        // Filtrar apenas os métodos que não têm "summary": "Root"
        const filteredMethods = Object.entries(methods).filter(([, details]: [string, any]) => details.summary !== 'Root');
        
        filteredMethods.forEach(([method]: [string, any]) => {
          this.updateSavedSetsSelect(method, path, currentConfigId);
        });
      });
    }
  }

  private displayError(error: unknown, container: HTMLDivElement) {
    const errorMessage = String(error);
    let statusText = '';
    let statusCode = '';
    let errorType = '';

    // Tentar extrair status code do erro
    if (errorMessage.includes('HTTP')) {
      const match = errorMessage.match(/HTTP (\d+): (.+)/);
      if (match) {
        statusCode = match[1];
        statusText = match[2];
        errorType = 'HTTP_ERROR';
      }
    } else if (errorMessage.includes('Failed to fetch')) {
      errorType = 'FETCH_ERROR';
    } else if (errorMessage.includes('CORS')) {
      errorType = 'CORS_ERROR';
    } else if (errorMessage.includes('NetworkError')) {
      errorType = 'NETWORK_ERROR';
    }

    const errorHtml = `
      <div class="error-message">
        <h4>Erro ao Carregar OpenAPI</h4>
        <div class="error-details">
          ${statusCode ? `<p><strong>Status:</strong> ${statusCode} ${statusText}</p>` : ''}
          <p><strong>Tipo:</strong> ${this.getErrorTypeDescription(errorType)}</p>
          <p><strong>Mensagem:</strong> ${this.escapeHtml(errorMessage)}</p>
        </div>
        
        ${errorType === 'FETCH_ERROR' || errorType === 'NETWORK_ERROR' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se:</p>
            <ul>
              <li>A URL está correta e acessível</li>
              <li>O servidor está online</li>
              <li>Você tem conexão com a internet</li>
              <li>O endpoint /openapi.json existe</li>
            </ul>
          </div>
        ` : ''}
        
        ${errorType === 'CORS_ERROR' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Erro de CORS detectado. Verifique se:</p>
            <ul>
              <li>O servidor permite requisições da origem ${window.location.origin}</li>
              <li>O servidor tem os headers CORS necessários</li>
              <li>Considere usar um proxy ou extensão para desenvolvimento</li>
            </ul>
          </div>
        ` : ''}
        
        ${statusCode === '403' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se você tem permissão para acessar esta API.</p>
          </div>
        ` : ''}
        
        ${statusCode === '404' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se a URL está correta e se o endpoint /openapi.json existe.</p>
          </div>
        ` : ''}
        
        ${statusCode === '401' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se a autenticação está configurada corretamente.</p>
          </div>
        ` : ''}
        
        <details class="error-technical">
          <summary>Detalhes Técnicos</summary>
          <div class="debug-info">
            <p><strong>URL:</strong> <span id="error-url"></span></p>
            <p><strong>User Agent:</strong> ${navigator.userAgent}</p>
            <p><strong>Origem:</strong> ${window.location.origin}</p>
          </div>
          <pre>${this.escapeHtml(error instanceof Error ? error.stack || errorMessage : errorMessage)}</pre>
        </details>
      </div>
    `;
    
    container.innerHTML = errorHtml;
    
    // Preencher informações de debug se disponíveis
    setTimeout(() => {
      const urlElement = document.getElementById('error-url');
      if (urlElement) {
        urlElement.textContent = window.location.href;
      }
    }, 100);
  }

  private getErrorTypeDescription(errorType: string): string {
    switch (errorType) {
      case 'FETCH_ERROR':
        return 'Falha na requisição (possível problema de rede ou CORS)';
      case 'CORS_ERROR':
        return 'Erro de CORS (política de mesma origem)';
      case 'NETWORK_ERROR':
        return 'Erro de rede';
      case 'HTTP_ERROR':
        return 'Erro HTTP';
      default:
        return 'Erro desconhecido';
    }
  }

  private showModal() {
    this.elements.configModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  private hideModal() {
    this.elements.configModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  private showAboutModal() {
    this.elements.aboutModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this.loadAppVersion();
  }

  private async loadAppVersion() {
    try {
      // Tentar obter versão compilada do Tauri (funciona em dev e produção)
      const version = await invoke<string>('get_app_version');
      const versionElement = document.getElementById('app-version');
      if (versionElement) {
        versionElement.textContent = version;
      }
    } catch (error) {
      console.warn('Failed to get app version from Tauri metadata, trying package.json:', error);
      try {
        // Fallback: tentar carregar do package.json (apenas em dev)
        const packageJson = await invoke<string>('read_package_json');
        const packageData = JSON.parse(packageJson);
        const versionElement = document.getElementById('app-version');
        if (versionElement) {
          versionElement.textContent = packageData.version || this.APP_VERSION;
        }
      } catch (fallbackError) {
        console.error('Failed to load app version from package.json, using fallback:', fallbackError);
        // Fallback final: usar versão embutida
        const versionElement = document.getElementById('app-version');
        if (versionElement) {
          versionElement.textContent = this.APP_VERSION;
        }
      }
    }
  }

  private hideAboutModal() {
    this.elements.aboutModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  private hideCustomEndpointModal() {
    this.elements.customEndpointModal.classList.add('hidden');
    document.body.style.overflow = '';
    this.clearCustomEndpointForm();
  }

  private showCustomEndpointModal(configId: string, editingEndpoint?: CustomEndpoint) {
    this.elements.customEndpointConfigId.value = configId;
    
    if (editingEndpoint) {
      this.elements.customEndpointModalTitle.textContent = 'Editar Endpoint Customizado';
      this.elements.customEndpointId.value = editingEndpoint.id;
      this.elements.customEndpointName.value = editingEndpoint.name;
      this.elements.customEndpointDescription.value = editingEndpoint.description || '';
      this.elements.customEndpointBaseUrl.value = editingEndpoint.base_url;
      this.elements.customEndpointPath.value = editingEndpoint.endpoint_path;
      this.elements.customEndpointMethod.value = editingEndpoint.method;
      this.elements.customEndpointExampleBody.value = editingEndpoint.example_body || '';
      this.elements.customEndpointExampleResult.value = editingEndpoint.example_result || '';
      
      // Load query params
      this.elements.customEndpointQueryParams.innerHTML = '';
      editingEndpoint.query_params.forEach(param => {
        this.addQueryParamField(param.name, param.type, param.required, param.default);
      });
    } else {
      this.elements.customEndpointModalTitle.textContent = 'Adicionar Endpoint Customizado';
      this.elements.customEndpointId.value = '';
      this.elements.customEndpointName.value = '';
      this.elements.customEndpointDescription.value = '';
      this.elements.customEndpointBaseUrl.value = '';
      this.elements.customEndpointPath.value = '';
      this.elements.customEndpointMethod.value = 'GET';
      this.elements.customEndpointExampleBody.value = '';
      this.elements.customEndpointExampleResult.value = '';
      this.elements.customEndpointQueryParams.innerHTML = '';
    }
    
    this.elements.customEndpointModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  private clearCustomEndpointForm() {
    this.elements.customEndpointForm.reset();
    this.elements.customEndpointId.value = '';
    this.elements.customEndpointConfigId.value = '';
    this.elements.customEndpointQueryParams.innerHTML = '';
  }

  private addQueryParamField(name: string = '', type: string = 'string', required: boolean = false, defaultValue: string = '') {
    const paramDiv = document.createElement('div');
    paramDiv.className = 'query-param-item';
    paramDiv.innerHTML = `
      <input type="text" placeholder="Nome" class="param-name" value="${this.escapeHtml(name)}" required />
      <select class="param-type">
        <option value="string" ${type === 'string' ? 'selected' : ''}>String</option>
        <option value="number" ${type === 'number' ? 'selected' : ''}>Number</option>
        <option value="boolean" ${type === 'boolean' ? 'selected' : ''}>Boolean</option>
      </select>
      <label class="param-required">
        <input type="checkbox" class="param-required-check" ${required ? 'checked' : ''} />
        Required
      </label>
      <input type="text" placeholder="Default" class="param-default" value="${this.escapeHtml(defaultValue)}" />
      <button type="button" class="remove-param-btn">&times;</button>
    `;
    
    paramDiv.querySelector('.remove-param-btn')?.addEventListener('click', () => {
      paramDiv.remove();
    });
    
    this.elements.customEndpointQueryParams.appendChild(paramDiv);
  }

  private async handleCustomEndpointSubmit() {
    const configId = this.elements.customEndpointConfigId.value;
    const endpointId = this.elements.customEndpointId.value;
    const name = this.elements.customEndpointName.value.trim();
    const description = this.elements.customEndpointDescription.value.trim();
    const baseUrl = this.elements.customEndpointBaseUrl.value.trim();
    const endpointPath = this.elements.customEndpointPath.value.trim();
    const method = this.elements.customEndpointMethod.value;
    const exampleBody = this.elements.customEndpointExampleBody.value.trim();
    const exampleResult = this.elements.customEndpointExampleResult.value.trim();

    if (!name || !baseUrl || !endpointPath) {
      this.showToast('Por favor, preencha os campos obrigatórios.', 'error');
      return;
    }

    // Collect query params
    const queryParams: QueryParam[] = [];
    const paramItems = this.elements.customEndpointQueryParams.querySelectorAll('.query-param-item');
    paramItems.forEach(item => {
      const paramName = (item.querySelector('.param-name') as HTMLInputElement).value.trim();
      const paramType = (item.querySelector('.param-type') as HTMLSelectElement).value;
      const paramRequired = (item.querySelector('.param-required-check') as HTMLInputElement).checked;
      const paramDefault = (item.querySelector('.param-default') as HTMLInputElement).value.trim();
      
      if (paramName) {
        queryParams.push({
          name: paramName,
          type: paramType,
          required: paramRequired,
          default: paramDefault || undefined
        });
      }
    });

    const endpointData = {
      id: endpointId || undefined,
      config_id: configId,
      name,
      description: description || undefined,
      base_url: baseUrl,
      endpoint_path: endpointPath,
      method,
      query_params: queryParams,
      example_body: exampleBody || undefined,
      example_result: exampleResult || undefined
    };

    try {
      if (endpointId) {
        await invoke('update_custom_endpoint', { configId, endpointId, endpointData });
        this.showToast('Endpoint atualizado com sucesso!', 'success');
      } else {
        await invoke('save_custom_endpoint', { configId, endpointData });
        this.showToast('Endpoint salvo com sucesso!', 'success');
      }
      
      this.hideCustomEndpointModal();
      
      // Refresh the custom endpoints display
      const currentConfigId = this.getCurrentConfigId();
      if (currentConfigId === configId) {
        await this.handleConfigSelection(configId);
      }
    } catch (error) {
      this.showToast(`Erro ao salvar endpoint: ${error}`, 'error');
    }
  }

  private async displayCustomEndpoints(config: Configuration, endpoints: CustomEndpoint[]) {
    const openApiContent = document.getElementById('openapi-content') as HTMLDivElement;
    
    if (endpoints.length === 0) {
      openApiContent.innerHTML = `
      <div class="config-header">
      <div class="selected-config">
            <button class="edit-config-btn" data-config-id="${config.id}" title="Editar configuração">
              ✏️ Editar
            </button>
            <button id="add-custom-endpoint-btn" class="add-custom-endpoint-btn" data-config-id="${config.id}">
              + Adicionar Endpoint Customizado
            </button>
          </div>
          <div class="empty-state">
            <p>Nenhum endpoint customizado adicionado ainda.</p>
            <p>Clique em "+ Adicionar Endpoint Customizado" para começar.</p>
          </div>
        </div>
      `;
      
      // Add event listener for the add button
      document.getElementById('add-custom-endpoint-btn')?.addEventListener('click', () => {
        this.showCustomEndpointModal(config.id);
      });
      
      return;
    }

    // Display custom endpoints in a similar format to OpenAPI endpoints
    let endpointsHtml = `
      <div class="selected-config">
        <div class="config-header">
          ${config.url ? `
          <div class="config-info">
            <h3>${this.escapeHtml(config.name)}</h3>
            <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
            <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'gcloud' : 'não'}</p>
          </div>
          ` : ''}
          <button id="add-custom-endpoint-btn" class="add-custom-endpoint-btn" data-config-id="${config.id}">
            + Adicionar Endpoint Customizado
          </button>
        </div>
        <div class="endpoints-container">
    `;

    const currentUser = await this.getCurrentUserName();

    endpoints.forEach(endpoint => {
      const pathId = this.normalizePath(endpoint.endpoint_path);
      const isCreator = endpoint.created_by === currentUser;
      
      endpointsHtml += `
        <div class="endpoint-item collapsed" data-method="${endpoint.method}" data-path="${endpoint.endpoint_path}">
          <div class="endpoint-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="method-badge ${endpoint.method.toLowerCase()}">${endpoint.method}</span>
            <div class="endpoint-path-container">
              <span class="endpoint-base-url">${this.escapeHtml(endpoint.base_url)}</span>
              <h4 class="endpoint-path">${this.escapeHtml(endpoint.endpoint_path)}</h4>
            </div>
            <div class="endpoint-meta">
              <h5 class="endpoint-name">${this.escapeHtml(endpoint.name)}</h5>
              ${endpoint.description ? `<p class="endpoint-description">${this.escapeHtml(endpoint.description)}</p>` : ''}
            </div>
            <div class="endpoint-actions">
              ${isCreator ? `
                <button class="edit-endpoint-btn" data-endpoint-id="${endpoint.id}" title="Editar" onclick="event.stopPropagation()">✏️</button>
                <button class="delete-endpoint-btn" data-endpoint-id="${endpoint.id}" title="Excluir" onclick="event.stopPropagation()">🗑️</button>
              ` : ''}
            </div>
          </div>
          ${endpoint.example_result ? `
            <div class="example-result">
              <details>
                <summary>Exemplo de Resposta</summary>
                <pre class="json-response">${this.escapeHtml(endpoint.example_result)}</pre>
              </details>
            </div>
          ` : ''}
          <div class="endpoint-content" id="endpoint-${endpoint.method}-${pathId}">
            ${this.generateCustomTestInterface(endpoint, pathId, config)}
          </div>
        </div>
      `;
    });

    endpointsHtml += `</div></div>`;
    openApiContent.innerHTML = endpointsHtml;

    // Add event listener for the add button
    document.getElementById('add-custom-endpoint-btn')?.addEventListener('click', () => {
      this.showCustomEndpointModal(config.id);
    });

    // Add event listeners for edit/delete buttons
    document.querySelectorAll('.edit-endpoint-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const endpointId = (e.currentTarget as HTMLElement).dataset.endpointId;
        const endpoint = endpoints.find(ep => ep.id === endpointId);
        if (endpoint) {
          this.showCustomEndpointModal(config.id, endpoint);
        }
      });
    });

    document.querySelectorAll('.delete-endpoint-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const endpointId = (e.currentTarget as HTMLElement).dataset.endpointId;
        const confirmed = await this.showConfirmDialog('Tem certeza que deseja excluir este endpoint?');
        if (confirmed) {
          try {
            await invoke('delete_custom_endpoint', {
              configId: config.id,
              endpointId,
              currentUser
            });
            this.showToast('Endpoint excluído com sucesso!', 'success');
            await this.handleConfigSelection(config.id);
          } catch (error) {
            this.showToast(`Erro ao excluir endpoint: ${error}`, 'error');
          }
        }
      });
    });

    // Attach event listeners for test interface
    this.attachTestInterfaceListeners(config, endpoints);

    // Attach event listeners for custom endpoint save/load buttons
    this.attachCustomSaveLoadListeners(config, endpoints);
  }

  private generateCustomTestInterface(endpoint: CustomEndpoint, pathId: string, config: Configuration): string {
    // Auto-detect path params from endpoint path
    const pathParams: string[] = [];
    const pathParamRegex = /\{([^}]+)\}/g;
    let match;
    while ((match = pathParamRegex.exec(endpoint.endpoint_path)) !== null) {
      pathParams.push(match[1]);
    }

    let interfaceHtml = `
      <div class="test-interface">
    `;

    // Path params section
    if (pathParams.length > 0) {
      interfaceHtml += `
        <div class="test-section">
          <div class="section-header">
            <h4>Path Parameters</h4>
            <button class="reset-btn" data-reset="custom-path-${endpoint.id}" title="Resetar Path Params">🔄</button>
          </div>
          <div class="params-grid">
            ${pathParams.map(param => `
              <div class="param-item">
                <label>${this.escapeHtml(param)}</label>
                <input type="text" class="path-param-input" data-param="${param}" placeholder="Valor para ${this.escapeHtml(param)}" />
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Query params section
    if (endpoint.query_params && endpoint.query_params.length > 0) {
      interfaceHtml += `
        <div class="test-section">
          <div class="section-header">
            <h4>Query Parameters</h4>
            <button class="reset-btn" data-reset="custom-query-${endpoint.id}" title="Resetar Query Params">🔄</button>
          </div>
          <div class="params-grid">
            ${endpoint.query_params.map(param => `
              <div class="param-item">
                <label>${this.escapeHtml(param.name)}${param.required ? ' *' : ''}</label>
                <input type="text" class="query-param-input" data-param="${param.name}" 
                  placeholder="${param.default ? `Default: ${this.escapeHtml(param.default)}` : 'Valor'}" 
                  value="${param.default || ''}" 
                  data-default="${param.default || ''}" />
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Body section
    if (endpoint.method === 'POST' || endpoint.method === 'PUT' || endpoint.method === 'PATCH') {
      // Store default body in the map to avoid HTML attribute escaping issues
      const bodyKey = `${endpoint.method}-${pathId}`;
      this.defaultBodyValues.set(bodyKey, endpoint.example_body || '');

      interfaceHtml += `
        <div class="test-section">
          <div class="section-header">
            <h4>Body (JSON)</h4>
            <button class="reset-btn" data-reset="custom-body-${endpoint.id}" title="Resetar Body">🔄</button>
          </div>
          <textarea id="body-${endpoint.method}-${pathId}" class="json-textarea" 
            placeholder='{"key": "value"}' rows="4">${endpoint.example_body ? this.escapeHtml(endpoint.example_body) : ''}</textarea>
        </div>
      `;
    }

    // Saved sets section
    interfaceHtml += `
        <details class="saved-sets-section">
          <summary>Conjuntos de Valores Salvos:</summary>
          <div class="save-set-controls">
            <input
              type="text"
              id="save-name-custom-${endpoint.id}"
              placeholder="Nome do conjunto"
              class="save-name-input"
            />
            <button
              class="save-set-btn save-custom-set-btn"
              data-endpoint-id="${endpoint.id}"
              data-config-id="${config.id}"
            >
              Salvar Local
            </button>
            ${config.databaseName && !config.isPrivate ? `
            <button
              class="save-set-database-btn save-custom-set-database-btn"
              data-endpoint-id="${endpoint.id}"
              data-config-id="${config.id}"
              title="Salvar no banco de dados"
            >
              Salvar no banco de dados
            </button>
            ` : ''}
            </button>
          </div>
          <div class="load-set-controls">
            <label for="saved-sets-custom-${endpoint.id}">Carregar conjunto:</label>
            <div class="load-set-row">
              <select
                id="saved-sets-filter-custom-${endpoint.id}"
                class="saved-sets-filter saved-custom-sets-filter"
                data-endpoint-id="${endpoint.id}"
                data-config-id="${config.id}"
              >
                <option value="todos">Todos</option>
                <option value="local">Apenas local</option>
                <option value="database">Apenas banco de dados</option>
              </select>
              <select
                id="saved-sets-custom-${endpoint.id}"
                class="saved-sets-select saved-custom-sets-select"
                data-endpoint-id="${endpoint.id}"
                data-config-id="${config.id}"
              >
                <option value="">Selecione um conjunto salvo...</option>
              </select>
              <button
                class="reload-sets-btn reload-custom-sets-btn"
                data-endpoint-id="${endpoint.id}"
                data-config-id="${config.id}"
                title="Recarregar conjuntos salvos"
              >
                🔄
              </button>
            </div>
          </div>
        </details>
    `;

    // Test button and result
    interfaceHtml += `
        <div class="test-section">
          <button class="test-btn" data-method="${endpoint.method}" data-path="${endpoint.endpoint_path}" data-path-id="${pathId}" data-base-url="${endpoint.base_url}" data-endpoint-id="${endpoint.id}">
            Testar Endpoint
          </button>
          <div id="test-result-${endpoint.method}-${pathId}" class="test-result"></div>
        </div>
      </div>
    `;

    return interfaceHtml;
  }

  private attachTestInterfaceListeners(config: Configuration, endpoints: CustomEndpoint[]) {
    endpoints.forEach(endpoint => {
      const pathId = this.normalizePath(endpoint.endpoint_path);
      const testBtn = document.querySelector(`.test-btn[data-method="${endpoint.method}"][data-path-id="${pathId}"]`) as HTMLButtonElement;

      if (testBtn) {
        testBtn.addEventListener('click', () => {
          this.executeCustomTest(endpoint, config, pathId);
        });
      }
    });
  }

  private attachCustomSaveLoadListeners(config: Configuration, endpoints: CustomEndpoint[]) {
    endpoints.forEach(endpoint => {
      // Save local button
      const saveLocalBtn = document.querySelector(`.save-custom-set-btn[data-endpoint-id="${endpoint.id}"]`) as HTMLButtonElement;
      if (saveLocalBtn) {
        saveLocalBtn.addEventListener('click', () => {
          this.saveCustomValueSet(endpoint.id, config.id, 'local');
        });
      }

      // Save database button
      const saveDatabaseBtn = document.querySelector(`.save-custom-set-database-btn[data-endpoint-id="${endpoint.id}"]`) as HTMLButtonElement;
      if (saveDatabaseBtn) {
        saveDatabaseBtn.addEventListener('click', () => {
          this.saveCustomValueSet(endpoint.id, config.id, 'database');
        });
      }

      // Select change - auto-load when a value is selected
      const select = document.getElementById(`saved-sets-custom-${endpoint.id}`) as HTMLSelectElement;
      if (select) {
        select.addEventListener('change', () => {
          const savedSetId = select.value;
          if (savedSetId) {
            this.loadCustomValueSet(endpoint.id, config.id, savedSetId);
          }
        });
      }

      // Filter select
      const filterSelect = document.getElementById(`saved-sets-filter-custom-${endpoint.id}`) as HTMLSelectElement;
      if (filterSelect) {
        filterSelect.addEventListener('change', () => {
          this.updateCustomSavedSetsSelect(endpoint.id, config.id);
        });
      }

      // Reload button
      const reloadBtn = document.querySelector(`.reload-custom-sets-btn[data-endpoint-id="${endpoint.id}"]`) as HTMLButtonElement;
      if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
          this.updateCustomSavedSetsSelect(endpoint.id, config.id);
        });
      }

      // Initialize the saved sets select
      this.updateCustomSavedSetsSelect(endpoint.id, config.id);
    });
  }

  private async executeCustomTest(endpoint: CustomEndpoint, config: Configuration, pathId: string) {
    // Collect path params
    const pathParams: Record<string, string> = {};
    const pathParamInputs = document.querySelectorAll(`#endpoint-${endpoint.method}-${pathId} .path-param-input`);
    pathParamInputs.forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      if (param) {
        pathParams[param] = (input as HTMLInputElement).value;
      }
    });

    // Collect query params
    const queryParams: Record<string, string> = {};
    const queryParamInputs = document.querySelectorAll(`#endpoint-${endpoint.method}-${pathId} .query-param-input`);
    queryParamInputs.forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      if (param) {
        queryParams[param] = (input as HTMLInputElement).value;
      }
    });

    // Collect body
    const bodyTextarea = document.getElementById(`body-${endpoint.method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';

    const testResult = document.getElementById(`test-result-${endpoint.method}-${pathId}`);
    if (!testResult) return;

    testResult.innerHTML = '<div class="test-loading">Executando teste...</div>';

    try {
      // Replace path params in the endpoint path
      let processedPath = endpoint.endpoint_path;
      Object.entries(pathParams).forEach(([key, value]) => {
        processedPath = processedPath.replace(`{${key}}`, encodeURIComponent(value));
      });

      const baseUrl = endpoint.base_url.replace(/\/$/, '');
      const queryString = Object.keys(queryParams).length > 0 
        ? '?' + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';

      const fullUrl = `${baseUrl}${processedPath}${queryString}`;

      // Process headers
      const processedHeaders: Record<string, string> = {};
      let sentUuid: string | undefined;
      
      if (config.useDefaultAuth) {
        const token = await invoke<string>('get_gcloud_token');
        processedHeaders['Authorization'] = `Bearer ${token}`;
        processedHeaders['TokenPortal'] = token;
      }

      if (config.headers) {
        config.headers.forEach(header => {
          let value = header.value;
          if (value === 'uuid') {
            const uuid = this.generateUUID();
            processedHeaders[header.name] = uuid;
            sentUuid = uuid;
          } else {
            processedHeaders[header.name] = value;
          }
        });
      }

      const response = await invoke<TestResponse>('make_test_request', {
        url: fullUrl,
        method: endpoint.method,
        useAuth: config.useDefaultAuth,
        headers: processedHeaders,
        body: endpoint.method !== 'GET' && endpoint.method !== 'HEAD' ? body : undefined
      });

      const timestamp = new Date().toISOString();
      const hasData = response.data && (typeof response.data === 'object' && Object.keys(response.data).length > 0 || typeof response.data === 'string' && response.data.trim());

      // Generate consistent pathId for search functionality
      const searchPathId = `${endpoint.method.toLowerCase()}-${endpoint.endpoint_path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

      // Display result with save buttons (same format as regular endpoints)
      testResult.innerHTML = `
        <div class="test-result success">
          <div class="test-status">
            <div class="test-status-header">
              <h5>Resposta ${response.status || 200} ${response.statusText || 'OK'}</h5>
              ${hasData ? `
                <div class="test-result-actions">
                  <input 
                    type="text" 
                    id="result-name-${endpoint.method}-${pathId}"
                    class="result-name-input"
                    placeholder="Nome do resultado..."
                    value="Resultado_${new Date().toLocaleString('pt-BR').replace(/[^\w]/g, '_')}"
                  />
                  <button 
                    class="save-result-btn save-local-btn" 
                    data-method="${endpoint.method}"
                    data-path="${endpoint.endpoint_path}"
                    data-config-id="${config.id}"
                    data-timestamp="${timestamp}"
                    data-save-type="local"
                    data-is-custom="true"
                  >
                    Salvar Local
                  </button>
                  ${config.databaseName && !config.isPrivate ? `
                    <button 
                      class="save-result-btn save-database-btn" 
                      data-method="${endpoint.method}"
                      data-path="${endpoint.endpoint_path}"
                      data-config-id="${config.id}"
                      data-timestamp="${timestamp}"
                      data-save-type="database"
                      data-is-custom="true"
                    >
                      Salvar no BD
                    </button>
                  ` : ''}
                  <button 
                    class="show-history-btn" 
                    data-method="${endpoint.method}"
                    data-path="${endpoint.endpoint_path}"
                    data-config-id="${config.id}"
                  >
                    Exibir Histórico
                  </button>
                </div>
              ` : ''}
            </div>
            ${response.headers ? `
              <div class="test-headers-section">
                <details>
                  <summary>Response Headers</summary>
                  <div class="headers-data-wrapper">
                    <pre id="headers-${endpoint.method}-${pathId}" class="test-headers">${this.escapeHtml(JSON.stringify(response.headers, null, 2))}</pre>
                    <button class="copy-btn" data-target="headers-${endpoint.method}-${pathId}">📋 Copiar</button>
                  </div>
                </details>
              </div>
            ` : ''}
          </div>
          <div class="test-response">
            <details open>
              <summary>Resposta</summary>
              <div class="response-search-container">
                <div class="response-search-header">
                  <input type="text" 
                         id="response-search-${searchPathId}" 
                         class="response-search-input" 
                         placeholder="Buscar na resposta..." 
                         data-response-id="response-${searchPathId}">
                  <button class="response-search-clear" data-search-input="response-search-${searchPathId}" title="Limpar busca">×</button>
                </div>
                <div class="response-search-info" id="response-search-info-${searchPathId}"></div>
              </div>
              <div class="response-data-wrapper">
                <pre id="response-${searchPathId}" class="test-response-data">${this.escapeHtml(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2))}</pre>
                <button class="copy-btn" data-target="response-${searchPathId}">📋 Copiar</button>
              </div>
            </details>
          </div>
        </div>
      `;

      // Attach event listeners for save buttons
      const saveButtons = testResult.querySelectorAll('.save-result-btn');
      saveButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const button = e.currentTarget as HTMLButtonElement;
          const saveType = button.dataset.saveType as 'local' | 'database';
          const resultNameInput = document.getElementById(`result-name-${endpoint.method}-${pathId}`) as HTMLInputElement;
          const resultName = resultNameInput?.value?.trim();
          
          if (!resultName) {
            this.showToast('Por favor, digite um nome para este resultado.', 'error');
            return;
          }

          try {
            const requestData = {
              url: fullUrl,
              method: endpoint.method,
              headers: processedHeaders,
              body: endpoint.method !== 'GET' && endpoint.method !== 'HEAD' ? body : undefined,
              pathParams,
              queryParams,
              sentUuid
            };

            if (saveType === 'local') {
              await this.saveCustomTestResultLocal(config.id, endpoint.method, endpoint.endpoint_path, resultName, requestData, response, timestamp);
              this.showToast('Resultado salvo localmente com sucesso!', 'success');
            } else {
              await this.saveCustomTestResultDatabase(config.databaseName!, config.id, endpoint.method, endpoint.endpoint_path, resultName, requestData, response, timestamp);
              this.showToast('Resultado salvo no banco de dados com sucesso!', 'success');
            }
          } catch (error) {
            this.showToast(`Erro ao salvar resultado: ${error}`, 'error');
          }
        });
      });

      // Setup search functionality for response
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.setupResponseSearch(endpoint.method, endpoint.endpoint_path, config.id);
        }, 100);
      });

      // Attach copy button listeners
      this.attachCopyButtonsListeners();

      // Attach history button listener
      const historyBtn = testResult.querySelector('.show-history-btn') as HTMLButtonElement;
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          this.showHistoryModal(config.id);
        });
      }
    } catch (error) {
      testResult.innerHTML = `
        <div class="test-error">
          <h4>Erro ao executar teste:</h4>
          <pre>${this.escapeHtml(String(error))}</pre>
        </div>
      `;
    }
  }

  private async saveCustomTestResultLocal(configId: string, method: string, path: string, name: string, requestData: any, response: TestResponse, timestamp: string) {
    await this.loadSavedResults();
    
    if (!this.savedResults[configId]) {
      this.savedResults[configId] = [];
    }
    
    const result: SavedResult = {
      id: this.generateUUID(),
      name,
      endpoint: {
        method,
        path,
        configId
      },
      request: {
        pathParams: requestData.pathParams || {},
        queryParams: requestData.queryParams || {},
        body: requestData.body || '',
        sentUuid: requestData.sentUuid
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data
      },
      timestamp
    };
    
    this.savedResults[configId].push(result);
    await this.saveSavedResults();
  }

  private async saveCustomTestResultDatabase(secretName: string, configId: string, method: string, path: string, name: string, requestData: any, response: TestResponse, timestamp: string) {
    const currentUser = await this.getCurrentUserName();
    
    // Remove Authorization and TokenPortal headers from saved data for security
    const sanitizedRequestData = {
      ...requestData,
      headers: requestData.headers ? Object.fromEntries(
        Object.entries(requestData.headers).filter(([key]) => 
          key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'tokenportal'
        )
      ) : {}
    };
    
    await invoke('save_to_postgres', {
      secretName,
      configId,
      endpointMethod: method,
      endpointPath: path,
      resultData: {
        id: this.generateUUID(),
        name,
        request: sanitizedRequestData,
        response: {
          status: response.status || 200,
          statusText: response.statusText || 'OK',
          headers: response.headers || {},
          data: response.data
        },
        timestamp,
        userAccount: currentUser
      }
    });
  }

  private toggleExtrasDropdown() {
    this.elements.extrasDropdown.classList.toggle('hidden');
  }

  private handleEscapeKey() {
    // Verificar se algum modal está aberto e fechá-lo
    if (!this.elements.configModal.classList.contains('hidden')) {
      this.hideModal();
    }
    
    if (!this.elements.aboutModal.classList.contains('hidden')) {
      this.hideAboutModal();
    }
    
    if (!this.elements.customEndpointModal.classList.contains('hidden')) {
      this.hideCustomEndpointModal();
    }
    
    // Verificar se modal de histórico está aberto
    const historyModal = document.querySelector('.history-modal:not(.hidden)') as HTMLElement;
    if (historyModal) {
      this.closeHistoryModal(historyModal);
    }
    
    // Fechar dropdown de opções extras
    if (!this.elements.extrasDropdown.classList.contains('hidden')) {
      this.elements.extrasDropdown.classList.add('hidden');
    }
  }

  private async handleSubmit() {
    const name = this.elements.nameInput.value.trim();
    const url = this.elements.urlInput.value.trim();
    const databaseName = this.elements.databaseInput.value.trim() || undefined;
    const useDefaultAuth = this.elements.authCheckbox.checked;
    const isPrivate = this.elements.privateCheckbox.checked;
    const headers = this.getHeadersFromForm();

    if (!name) {
      this.showToast('Por favor, digite um nome para a configuração.', 'error');
      return;
    }

    // Get current user for created_by
    const currentUser = await this.getCurrentUserName();

    // Check if converting from private to non-private
    let originalIsPrivate = true;
    if (this.editingId) {
      const existingConfig = this.configs.find(c => c.id === this.editingId);
      if (existingConfig) {
        originalIsPrivate = existingConfig.isPrivate !== false; // Default to true if undefined
      }
    }

    // If converting from private to non-private (only when editing existing config)
    if (this.editingId && originalIsPrivate && !isPrivate) {
      if (!databaseName) {
        // No database secret configured - save locally and show alert
        this.showToast('Para salvar configurações no banco de dados, configure um Secret GCP.', 'error');
        // Continue with saving locally only
      } else {
        // Has database secret - show sync modal
        this.pendingConfig = {
          id: this.editingId,
          name,
          url: url || undefined,
          databaseName,
          useDefaultAuth,
          headers,
          isPrivate: false,
          created_by: this.configs.find(c => c.id === this.editingId)?.created_by || currentUser
        };
        this.showSyncModal();
        return; // Wait for sync modal confirmation
      }
    }

    if (this.editingId) {
      const configIndex = this.configs.findIndex(c => c.id === this.editingId);
      if (configIndex !== -1) {
        this.configs[configIndex] = {
          id: this.editingId,
          name,
          url: url || undefined,
          databaseName,
          useDefaultAuth,
          headers,
          isPrivate,
          created_by: this.configs[configIndex].created_by || currentUser
        };
      }
    } else {
      // For custom configs without URL, use UUID instead of URL normalization
      const configId = url ? this.normalizeUrlToId(url) : this.generateUUID();
      
      const newConfig: Configuration = {
        id: configId,
        name,
        url: url || undefined,
        databaseName,
        useDefaultAuth,
        headers,
        isPrivate,
        created_by: currentUser
      };
      this.configs.push(newConfig);
    }

    await this.saveConfigs();

    // If non-private and has databaseName, save to database
    const configToSave = this.editingId 
      ? this.configs.find(c => c.id === this.editingId)
      : this.configs[this.configs.length - 1];
    
    if (configToSave && !configToSave.isPrivate && configToSave.databaseName) {
      try {
        await invoke('save_config_to_postgres', {
          secretName: configToSave.databaseName,
          configData: configToSave
        });
        configToSave.isInDatabase = true;
        await this.saveConfigs();
      } catch (error) {
        console.error('Failed to save configuration to database:', error);
        this.showToast(`Erro ao salvar configuração no banco: ${String(error)}`, 'error');
        // Continue with local save only
      }
    }
    
    // Se a configuração atualizada for a que está selecionada, resetar a seleção
    const currentConfigId = this.getCurrentConfigId();
    const updatedConfigId = this.editingId;
    
    if (currentConfigId === updatedConfigId) {
      // Resetar para o valor padrão e atualizar a interface
      this.elements.configSelect.value = '';
      this.handleConfigSelection(''); // Chamar diretamente para atualizar a interface
    }
    
    // Add secret name to databaseSecrets if not already there
    if (databaseName && !this.databaseSecrets.includes(databaseName)) {
      this.databaseSecrets.push(databaseName);
      await this.saveDatabaseSecrets();
      this.renderDatabaseSecrets();
    }
    
    this.updateConfigSelect();
    this.renderConfigs();
    this.resetForm();
  }

  private resetForm() {
    this.elements.configForm.reset();
    this.clearHeaderFields();
    this.editingId = null;
    this.elements.submitBtn.textContent = 'Adicionar Configuração';
    this.elements.cancelBtn.classList.add('hidden');
    this.elements.privateCheckbox.disabled = false;
  }

  private renderConfigs() {
    if (this.configs.length === 0) {
      this.elements.configsList.innerHTML = '<p class="empty-state">Nenhuma configuração adicionada ainda.</p>';
      return;
    }

    let html = '';
    this.configs.forEach(config => {
      // Add prefix based on config location
      const prefix = config.isInDatabase && config.databaseName
        ? `[DB][${this.escapeHtml(config.databaseName)}] `
        : '[L] ';
      
      const displayName = prefix + this.escapeHtml(config.name);

      const statusBadge = config.isPrivate 
        ? '<span class="config-status-badge private">Privada</span>' 
        : config.isInDatabase 
          ? '<span class="config-status-badge online">Online</span>' 
          : '<span class="config-status-badge local">Local</span>';

      html += `
        <div class="config-item" data-id="${config.id}">
          <div class="config-details">
            <div class="config-title-row">
              <h4>${displayName}</h4>
              ${statusBadge}
            </div>
            <p><strong>ID:</strong> ${this.escapeHtml(config.id)}</p>
            <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'Padrão' : 'Custom'}</p>
            ${config.url ? `<p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>` : ''}
            ${config.databaseName ? `<p><strong>Banco de Dados:</strong> ${this.escapeHtml(config.databaseName)}</p>` : ''}
            ${config.headers && config.headers.length > 0 ? `
              <p><strong>Headers:</strong></p>
              <div class="config-headers">
                ${config.headers.map(header => 
                  `<span class="config-header">${this.escapeHtml(header.name)}: ${this.escapeHtml(header.value)}</span>`
                ).join('')}
              </div>
            ` : ''}
          </div>
          <div class="config-actions">
            <button class="edit-btn" data-id="${config.id}">Editar</button>
            <button class="delete-btn" data-id="${config.id}">Excluir</button>
          </div>
        </div>
      `;
    });

    this.elements.configsList.innerHTML = html;
    this.attachConfigEventListeners();
  }

  private attachConfigEventListeners() {
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this.editConfig(id);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) await this.deleteConfig(id);
      });
    });
  }

  private editConfig(id: string) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;

    this.editingId = id;
    this.elements.nameInput.value = config.name;
    this.elements.urlInput.value = config.url || '';
    this.elements.databaseInput.value = config.databaseName || '';
    this.elements.authCheckbox.checked = config.useDefaultAuth;
    this.elements.privateCheckbox.checked = config.isPrivate !== false; // Default to true if undefined
    
    // Disable private checkbox if config is in database (cannot change back to private)
    if (config.isInDatabase) {
      this.elements.privateCheckbox.disabled = true;
    } else {
      this.elements.privateCheckbox.disabled = false;
    }
    
    // Limpar campos de header existentes
    this.clearHeaderFields();
    
    // Carregar headers existentes
    if (config.headers && config.headers.length > 0) {
      config.headers.forEach(header => {
        this.addHeaderField(header.name, header.value);
      });
    }
    
    this.elements.submitBtn.textContent = 'Atualizar Configuração';
    this.elements.cancelBtn.classList.remove('hidden');
    
    this.elements.nameInput.focus();
    this.showModal();
  }

  private showSyncModal() {
    this.elements.syncModal.classList.remove('hidden');
  }

  private hideSyncModal() {
    this.elements.syncModal.classList.add('hidden');
    this.pendingConfig = null;
  }

  private async handleSyncConfirm() {
    if (!this.pendingConfig || !this.pendingConfig.databaseName) {
      this.showToast('Configuração pendente inválida', 'error');
      this.hideSyncModal();
      return;
    }

    const syncValueSets = this.elements.syncValueSetsCheckbox.checked;
    const syncTestResults = this.elements.syncTestResultsCheckbox.checked;
    const syncCustomEndpoints = this.elements.syncCustomEndpointsCheckbox.checked;

    // Save configuration to database
    try {
      await invoke('save_config_to_postgres', {
        secretName: this.pendingConfig.databaseName,
        configData: this.pendingConfig
      });
      this.pendingConfig.isInDatabase = true;
    } catch (error) {
      console.error('Failed to save configuration to database:', error);
      this.showToast(`Erro ao salvar configuração no banco: ${String(error)}`, 'error');
      this.hideSyncModal();
      return;
    }

    // Sync value sets if selected
    if (syncValueSets) {
      try {
        const savedValueSets = await invoke<any>('load_app_data', { key: this.SAVED_SETS_KEY });
        if (savedValueSets && Array.isArray(savedValueSets)) {
          for (const valueSet of savedValueSets) {
            if (valueSet.configId === this.pendingConfig?.id) {
              await invoke('save_value_set_to_postgres', {
                secretName: this.pendingConfig.databaseName,
                configId: this.pendingConfig.id,
                endpointMethod: valueSet.endpoint.method,
                endpointPath: valueSet.endpoint.path,
                valueSetData: valueSet
              });
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync value sets:', error);
        this.showToast(`Erro ao sincronizar value sets: ${String(error)}`, 'error');
      }
    }

    // Sync test results if selected
    if (syncTestResults) {
      try {
        const savedResults = await invoke<any>('load_app_data', { key: this.SAVED_RESULTS_KEY });
        if (savedResults && Array.isArray(savedResults)) {
          for (const result of savedResults) {
            if (result.configId === this.pendingConfig?.id) {
              await invoke('save_to_postgres', {
                secretName: this.pendingConfig.databaseName,
                configId: this.pendingConfig.id,
                endpointMethod: result.endpoint.method,
                endpointPath: result.endpoint.path,
                resultData: result
              });
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync test results:', error);
        this.showToast(`Erro ao sincronizar resultados de testes: ${String(error)}`, 'error');
      }
    }

    // Sync custom endpoints if selected
    if (syncCustomEndpoints) {
      try {
        const customEndpoints = await invoke<any>('list_custom_endpoints', { 
          configId: this.pendingConfig!.id,
          databaseName: this.pendingConfig!.databaseName
        });
        if (customEndpoints && Array.isArray(customEndpoints)) {
          for (const endpoint of customEndpoints) {
            await invoke('save_custom_endpoint', {
              configId: this.pendingConfig!.id,
              endpointData: endpoint
            });
          }
        }
      } catch (error) {
        console.error('Failed to sync custom endpoints:', error);
        this.showToast(`Erro ao sincronizar endpoints customizados: ${String(error)}`, 'error');
      }
    }

    // Update local config
    const configIndex = this.configs.findIndex(c => c.id === this.pendingConfig!.id);
    if (configIndex !== -1) {
      this.configs[configIndex] = this.pendingConfig;
      this.configs[configIndex].isInDatabase = true;
    } else {
      this.configs.push(this.pendingConfig);
      this.configs[this.configs.length - 1].isInDatabase = true;
    }

    await this.saveConfigs();
    
    // Add secret name to databaseSecrets if not already there
    if (this.pendingConfig.databaseName && !this.databaseSecrets.includes(this.pendingConfig.databaseName)) {
      this.databaseSecrets.push(this.pendingConfig.databaseName);
      await this.saveDatabaseSecrets();
      this.renderDatabaseSecrets();
    }
    
    this.updateConfigSelect();
    this.renderConfigs();
    this.resetForm();
    this.hideSyncModal();
    this.showToast('Configuração sincronizada com sucesso!', 'success');
  }

  private handleSyncCancel() {
    this.hideSyncModal();
  }

  private async deleteConfig(id: string) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;

    // Only allow deleting local configs (not in database)
    if (config.isInDatabase) {
      this.showToast('Configurações salvas no banco de dados não podem ser excluídas pelo app. Use o console PostgreSQL para gerenciar os registros.', 'error');
      return;
    }

    const confirmed = await this.showConfirmDialog(`Tem certeza que deseja excluir a configuração "${config.name}"? Esta ação não pode ser desfeita.`);
    if (!confirmed) {
      return;
    }

    this.configs = this.configs.filter(c => c.id !== id);
    await this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private attachTestEventListeners() {
    // Adicionar event listeners para testar
    document.querySelectorAll('.test-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.executeTest(method, path, configId);
        }
      });
    });

    // Adicionar event listeners para salvar conjuntos localmente
    document.querySelectorAll('.save-set-btn').forEach(btn => {
      const handleSaveSetClick = async (e: Event) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          await this.saveValueSet(method, path, configId);
        }
      };
      btn.addEventListener('click', handleSaveSetClick);
    });
    
    // Adicionar event listeners para salvar conjuntos no banco de dados
    const databaseButtons = document.querySelectorAll('.save-set-database-btn');
    
    databaseButtons.forEach(btn => {
      const handleSaveSetDatabaseClick = async (e: Event) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          await this.saveValueSet(method, path, configId, 'database');
        }
      };
      btn.addEventListener('click', handleSaveSetDatabaseClick);
    });

    // Adicionar event listeners para filtro de conjuntos
    document.querySelectorAll('.saved-sets-filter').forEach(filter => {
      filter.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.updateSavedSetsSelect(method, path, configId);
        }
      });
    });

    // Adicionar event listeners para carregar conjuntos
    document.querySelectorAll('.saved-sets-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        const selectedId = target.value;
        
        if (method && path && configId && selectedId) {
          this.loadValueSet(method, path, configId, selectedId);
        }
      });
    });

    // Adicionar event listeners para excluir conjuntos
    document.querySelectorAll('.delete-set-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;

        if (method && path && configId) {
          await this.deleteValueSet(method, path, configId);
        }
      });
    });

    // Adicionar event listener para o botão de recarregar secret
    document.querySelectorAll('.reload-secret-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const configId = target.dataset.configId;
        const secretName = target.dataset.secretName;
        
        if (configId && secretName) {
          await this.reloadSecret(configId, secretName);
        }
      });
    });
  }

  private async reloadSecret(configId: string, secretName: string) {
    const config = this.configs.find(c => c.id === configId);
    if (!config) return;

    // Mostrar indicador de carregamento no botão
    const reloadBtn = document.querySelector(`.reload-secret-btn[data-config-id="${configId}"]`) as HTMLButtonElement;
    if (reloadBtn) {
      reloadBtn.innerHTML = '🔄 Carregando...';
      reloadBtn.disabled = true;
    }

    try {
      // Tentar acessar o banco para verificar se o secret está acessível
      await invoke('list_postgres_results', {
        secretName: secretName,
        configId
      });

      // Atualizar mensagem de sucesso
      const configInfo = document.querySelector('.config-info');
      if (configInfo) {
        // Remover mensagens anteriores
        const existingMessages = configInfo.querySelectorAll('.database-success, .database-error');
        existingMessages.forEach(msg => msg.remove());

        // Adicionar mensagem de sucesso
        const successDiv = document.createElement('div');
        successDiv.className = 'database-success';
        successDiv.innerHTML = `✅ Secret "${this.escapeHtml(secretName)}" recarregado com sucesso`;
        
        // Inserir após a linha do Banco de Dados
        const dbLabel = Array.from(configInfo.children).find(child => 
          child.textContent?.includes('Banco de Dados:')
        );
        if (dbLabel) {
          dbLabel.parentNode?.insertBefore(successDiv, dbLabel.nextSibling);
        }
      }

      this.showToast('Secret recarregado com sucesso!', 'success');
    } catch (error) {
      console.error('Failed to reload database results:', error);
      const errorMessage = String(error);
      
      if (errorMessage.includes('NOT_FOUND') && errorMessage.includes('Secret')) {
        // Atualizar mensagem de erro
        const configInfo = document.querySelector('.config-info');
        if (configInfo) {
          // Remover mensagens anteriores
          const existingMessages = configInfo.querySelectorAll('.database-success, .database-error');
          existingMessages.forEach(msg => msg.remove());

          // Adicionar mensagem de erro
          const errorDiv = document.createElement('div');
          errorDiv.className = 'database-error';
          errorDiv.innerHTML = `⚠️ Erro ao acessar secret "${this.escapeHtml(secretName)}": Secret não encontrado ou sem permissão. Verifique a configuração no GCP.`;
          
          // Inserir após a linha do Banco de Dados
          const dbLabel = Array.from(configInfo.children).find(child => 
            child.textContent?.includes('Banco de Dados:')
          );
          if (dbLabel) {
            dbLabel.parentNode?.insertBefore(errorDiv, dbLabel.nextSibling);
          }
        }
        this.showToast('Erro ao acessar secret. Verifique a configuração no GCP.', 'error');
      } else {
        this.showToast('Erro ao recarregar secret.', 'error');
      }
    } finally {
      // Restaurar botão
      if (reloadBtn) {
        reloadBtn.innerHTML = '🔄 Recarregar Secret';
        reloadBtn.disabled = false;
      }
    }
  }

  private async saveCustomValueSet(endpointId: string, configId: string, saveType: 'local' | 'database' = 'local') {
    const nameInput = document.getElementById(`save-name-custom-${endpointId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();

    if (!name) {
      this.showToast('Por favor, digite um nome para este conjunto de valores.', 'error');
      return;
    }

    // Get the endpoint to get the actual HTTP method
    const config = this.configs.find(c => c.id === configId);
    if (!config) {
      this.showToast('Configuração não encontrada.', 'error');
      return;
    }

    const customEndpoints = await invoke<CustomEndpoint[]>('list_custom_endpoints', { 
      configId: config.id,
      databaseName: config.databaseName
    });
    const endpoint = customEndpoints.find((e: CustomEndpoint) => e.id === endpointId);
    if (!endpoint) {
      this.showToast('Endpoint não encontrado.', 'error');
      return;
    }

    const pathId = this.normalizePath(endpoint.endpoint_path);

    // Get the endpoint element to collect path params and query params
    const endpointElement = document.querySelector(`#endpoint-${endpoint.method}-${pathId}`) as HTMLElement;
    if (!endpointElement) {
      this.showToast('Elemento do endpoint não encontrado.', 'error');
      return;
    }

    // Coletar path params atuais
    const pathParams: Record<string, string> = {};
    endpointElement.querySelectorAll('.path-param-input').forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

    // Coletar query params atuais
    const queryParams: Record<string, string> = {};
    endpointElement.querySelectorAll('.query-param-input').forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        queryParams[param] = value;
      }
    });

    // Coletar body atual
    const bodyTextarea = document.getElementById(`body-${endpoint.method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';

    if (saveType === 'database') {
      const dbName = config?.databaseName || config?.gcpSecretName;
      if (!dbName) {
        this.showToast('Configuração não possui banco de dados configurado.', 'error');
        return;
      }

      try {
        const userAccount = await this.getCurrentUserName();

        const valueSetData = {
          name,
          pathParams,
          queryParams,
          body,
          userAccount,
          endpointId,
          savedIn: 'database'
        };

        // Salvar no banco de dados
        const objectPath = await invoke<string>('save_value_set_to_postgres', {
          secretName: dbName,
          configId,
          endpointMethod: endpoint.method,
          endpointPath: endpoint.endpoint_path,
          valueSetData
        });

        this.showToast(`Conjunto de valores salvo no banco de dados com sucesso! (${objectPath})`, 'success');

        // Atualizar o select para incluir os conjuntos do banco de dados
        this.updateCustomSavedSetsSelect(endpointId, configId);

      } catch (error) {
        console.error('Failed to save custom value set to PostgreSQL database:', error);
        this.showToast(`Erro ao salvar no banco de dados: ${String(error)}`, 'error');
      }
    } else {
      // Salvar localmente
      // Inicializar estrutura se não existir
      if (!this.customSavedValueSets[configId]) {
        this.customSavedValueSets[configId] = {};
      }
      if (!this.customSavedValueSets[configId][endpointId]) {
        this.customSavedValueSets[configId][endpointId] = [];
      }

      // Verificar se já existe um conjunto com o mesmo nome
      const existingIndex = this.customSavedValueSets[configId][endpointId].findIndex(set => set.name === name);

      if (existingIndex !== -1) {
        // Substituir o conjunto existente
        this.customSavedValueSets[configId][endpointId][existingIndex] = {
          ...this.customSavedValueSets[configId][endpointId][existingIndex],
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString()
        };
        this.showToast('Conjunto de valores atualizado com sucesso!', 'success');
      } else {
        // Criar novo conjunto
        const savedSet: SavedValueSet = {
          id: Date.now().toString(),
          name,
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString()
        };

        // Adicionar o conjunto salvo
        this.customSavedValueSets[configId][endpointId].push(savedSet);
        this.showToast('Conjunto de valores salvo com sucesso!', 'success');
      }

      // Salvar no app_data_dir
      await this.saveCustomSavedValueSets();

      // Atualizar o select
      this.updateCustomSavedSetsSelect(endpointId, configId);
    }
  }

  private async saveValueSet(method: string, path: string, configId: string, saveType: 'local' | 'database' = 'local') {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este conjunto de valores.', 'error');
      return;
    }

    // Coletar path params atuais
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

    // Coletar query params atuais
    const queryParams: Record<string, string> = {};
    document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        queryParams[param] = value;
      }
    });

    // Coletar body atual
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';

    if (saveType === 'database') {
      // Salvar no banco de dados
      const config = this.configs.find(c => c.id === configId);
      const dbName = config?.databaseName || config?.gcpSecretName;
      if (!config || !dbName) {
        this.showToast('Configuração não possui banco de dados configurado.', 'error');
        return;
      }

      try {
        // Obter conta do usuário para adicionar ao resultado
        const userAccount = await invoke<string>('get_gcloud_account');
        
        // Preparar dados para salvar no banco de dados
        const valueSetData = {
          id: Date.now().toString(),
          name,
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString(),
          endpoint: {
            method,
            path
          },
          userAccount,
          savedIn: 'database'
        };

        // Salvar no banco de dados
        const objectPath = await invoke<string>('save_value_set_to_postgres', {
          secretName: dbName,
          configId,
          endpointMethod: method,
          endpointPath: path,
          valueSetData
        });

        this.showToast(`Conjunto de valores salvo no banco de dados com sucesso! (${objectPath})`, 'success');
        
        // Atualizar o select para incluir os conjuntos do banco de dados
        this.updateSavedSetsSelect(method, path, configId);
        
      } catch (error) {
        console.error('Failed to save value set to PostgreSQL database:', error);
        this.showToast(`Erro ao salvar no banco de dados: ${String(error)}`, 'error');
      }
    } else {
      // Salvar localmente (código existente)
      // Inicializar estrutura se não existir
      if (!this.savedValueSets[configId]) {
        this.savedValueSets[configId] = {};
      }
      if (!this.savedValueSets[configId][method]) {
        this.savedValueSets[configId][method] = {};
      }
      if (!this.savedValueSets[configId][method][path]) {
        this.savedValueSets[configId][method][path] = [];
      }

      // Verificar se já existe um conjunto com o mesmo nome
      const existingIndex = this.savedValueSets[configId][method][path].findIndex(set => set.name === name);
      
      if (existingIndex !== -1) {
        // Substituir o conjunto existente
        this.savedValueSets[configId][method][path][existingIndex] = {
          ...this.savedValueSets[configId][method][path][existingIndex],
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString()
        };
        this.showToast('Conjunto de valores atualizado com sucesso!', 'success');
      } else {
        // Criar novo conjunto
        const savedSet: SavedValueSet = {
          id: Date.now().toString(),
          name,
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString()
        };

        // Adicionar o conjunto salvo
        this.savedValueSets[configId][method][path].push(savedSet);
        this.showToast('Conjunto de valores salvo com sucesso!', 'success');
      }
      
      // Salvar no app_data_dir
      await this.saveSavedValueSets();
      
      // Atualizar o select
      this.updateSavedSetsSelect(method, path, configId);
    }
  }

  private async loadCustomValueSet(endpointId: string, configId: string, savedSetId: string) {
    // Get the endpoint to get the actual HTTP method and path
    const config = this.configs.find(c => c.id === configId);
    if (!config) {
      this.showToast('Configuração não encontrada.', 'error');
      return;
    }

    const customEndpoints = await invoke<CustomEndpoint[]>('list_custom_endpoints', { 
      configId: config.id,
      databaseName: config.databaseName
    });
    const endpoint = customEndpoints.find((e: CustomEndpoint) => e.id === endpointId);
    if (!endpoint) {
      this.showToast('Endpoint não encontrado.', 'error');
      return;
    }

    const pathId = this.normalizePath(endpoint.endpoint_path);

    // Get the endpoint element to fill in the values
    const endpointElement = document.querySelector(`#endpoint-${endpoint.method}-${pathId}`) as HTMLElement;
    if (!endpointElement) {
      this.showToast('Elemento do endpoint não encontrado.', 'error');
      return;
    }

    // Verificar se é um conjunto do banco de dados ou local
    const isDatabaseSet = savedSetId.startsWith('database-');
    const actualId = isDatabaseSet ? savedSetId.substring(9) : savedSetId.substring(6); // Remove "database-" ou "local-"

    let savedSet: any;

    if (isDatabaseSet) {
      // Carregar conjunto do banco de dados
      try {
        if (!config.databaseName) {
          this.showToast('Configuração não possui banco de dados configurado.', 'error');
          return;
        }

        const result = await invoke<any>('load_value_set_from_postgres', {
          secretName: config.databaseName,
          configId: config.id,
          valueSetId: actualId
        });

        if (result) {
          savedSet = result;
        } else {
          this.showToast('Conjunto não encontrado no banco de dados.', 'error');
          return;
        }
      } catch (error) {
        console.error('Failed to load custom value set from database:', error);
        this.showToast('Erro ao carregar conjunto do banco de dados.', 'error');
        return;
      }
    } else {
      // Carregar conjunto local
      savedSet = this.customSavedValueSets[configId]?.[endpointId]?.find(set => set.id === actualId);

      if (!savedSet) {
        console.error('Conjunto salvo não encontrado:', actualId);
        return;
      }
    }

    // Preencher path params
    Object.entries(savedSet.pathParams).forEach(([param, value]) => {
      const input = endpointElement.querySelector(`.path-param-input[data-param="${param}"]`) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
      }
    });

    // Preencher query params
    Object.entries(savedSet.queryParams).forEach(([param, value]) => {
      const input = endpointElement.querySelector(`.query-param-input[data-param="${param}"]`) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
      }
    });

    // Preencher body
    const bodyTextarea = document.getElementById(`body-${endpoint.method}-${pathId}`) as HTMLTextAreaElement;
    if (bodyTextarea) {
      bodyTextarea.value = savedSet.body;
    }

    // Preencher o input do nome com o nome do conjunto
    const nameInput = document.getElementById(`save-name-custom-${endpointId}`) as HTMLInputElement;
    if (nameInput) {
      nameInput.value = savedSet.name;
    }
  }

  private async updateCustomSavedSetsSelect(endpointId: string, configId: string) {
    const select = document.getElementById(`saved-sets-custom-${endpointId}`) as HTMLSelectElement;
    const filterSelect = document.getElementById(`saved-sets-filter-custom-${endpointId}`) as HTMLSelectElement;

    if (!select || !filterSelect) {
      console.error('Select elements not found for endpointId:', endpointId);
      return;
    }

    const filterType = filterSelect.value;

    select.innerHTML = '<option value="">Selecione um conjunto salvo...</option>';

    // Get the endpoint to get the actual HTTP method and path
    const config = this.configs.find(c => c.id === configId);
    if (!config) {
      console.error('Config not found for configId:', configId);
      return;
    }

    try {
      const customEndpoints = await invoke<CustomEndpoint[]>('list_custom_endpoints', { 
        configId: config.id,
        databaseName: config.databaseName
      });
      
      const endpoint = customEndpoints.find((e: CustomEndpoint) => e.id === endpointId);
      if (!endpoint) {
        console.error('Endpoint not found for endpointId:', endpointId);
        return;
      }

      // Adicionar conjuntos locais
      if (filterType === 'todos' || filterType === 'local') {
        const localSets = this.customSavedValueSets[configId]?.[endpointId] || [];
        localSets.forEach(savedSet => {
          const option = document.createElement('option');
          option.value = `local-${savedSet.id}`;
          option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()}) [Local]`;
          select.appendChild(option);
        });
      }

      // Adicionar conjuntos do banco de dados
      if (filterType === 'todos' || filterType === 'database') {
        if (config && config.databaseName) {
          
          const results = await invoke<any>('list_postgres_value_sets', {
            secretName: config.databaseName,
            configId,
            endpointMethod: endpoint.method,
            endpointPath: endpoint.endpoint_path
          });

          // Handle both array and object with valueSets property
          const valueSets = Array.isArray(results) ? results : (results?.valueSets || []);
          
          if (valueSets.length > 0) {
            valueSets.forEach((valueSet: any) => {
              const option = document.createElement('option');
              // Handle different response structures
              const objectPath = valueSet.objectPath || valueSet.id;
              const name = valueSet.valueSet?.name || valueSet.name;
              const createdAt = valueSet.createdAt || valueSet.valueSet?.createdAt;
              
              option.value = `database-${objectPath}`;
              option.textContent = `${name} (${new Date(createdAt).toLocaleDateString()}) [Banco de Dados]`;
              select.appendChild(option);
            });
          }
        }
      }
    } catch (error) {
      console.error('Error in updateCustomSavedSetsSelect:', error);
    }
  }

  private async loadValueSet(method: string, path: string, configId: string, savedSetId: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // Verificar se é um conjunto do banco de dados ou local
    const isDatabaseSet = savedSetId.startsWith('database-');
    const actualId = isDatabaseSet ? savedSetId.substring(9) : savedSetId.substring(6); // Remove "database-" ou "local-"
    
    let savedSet: any;
    
    if (isDatabaseSet) {
      // Carregar conjunto do banco de dados
      try {
        const config = this.configs.find(c => c.id === configId);
        if (!config || !config.databaseName) {
          this.showToast('Configuração não possui banco de dados configurado.', 'error');
          return;
        }
        
        const databaseSets = await invoke<Array<any>>('list_postgres_value_sets', {
          secretName: config.databaseName,
          configId
        });
        
        // Filtrar apenas os conjuntos deste endpoint e encontrar o ID correspondente
        const endpointDatabaseSets = databaseSets.filter(set => 
          set.endpoint?.method === method && set.endpoint?.path === path
        );
        
        savedSet = endpointDatabaseSets.find(set => set.id === actualId);
        
        if (!savedSet) {
          console.error('Conjunto do banco de dados não encontrado:', actualId);
          return;
        }
      } catch (error) {
        console.error('Failed to load database value set:', error);
        this.showToast('Erro ao carregar conjunto do banco de dados.', 'error');
        return;
      }
    } else {
      // Carregar conjunto local
      savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === actualId);
      
      if (!savedSet) {
        console.error('Conjunto salvo não encontrado:', actualId);
        return;
      }
    }

    // Preencher path params
    Object.entries(savedSet.pathParams).forEach(([param, value]) => {
      const inputId = `path-param-${param}-${pathId}`;
      const input = document.getElementById(inputId) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
      }
    });

    // Preencher query params
    Object.entries(savedSet.queryParams).forEach(([param, value]) => {
      const inputId = `param-${param}-${pathId}`;
      const input = document.getElementById(inputId) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
      }
    });

    // Preencher body
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    if (bodyTextarea) {
      bodyTextarea.value = savedSet.body;
    }

    // Preencher o input do nome com o nome do conjunto
    const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
    if (nameInput) {
      nameInput.value = savedSet.name;
    }
  }

  private async updateSavedSetsSelect(method: string, path: string, configId: string) {
    // Esperar um pouco para garantir que o DOM está pronto
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    const filter = document.getElementById(`saved-sets-filter-${method}-${pathId}`) as HTMLSelectElement;
    const loadingIndicator = document.getElementById(`loading-${method}-${pathId}`);
    
    if (!select || !filter) return;

    const filterType = filter.value;
    
    // Mostrar indicador de carregamento se estiver carregando do banco de dados
    if (filterType === 'todos' || filterType === 'database') {
      const config = this.configs.find(c => c.id === configId);
      if (config && (config.databaseName || config.gcpSecretName) && loadingIndicator) {
        loadingIndicator.style.display = 'inline-flex';
      }
    }
    
    select.innerHTML = '<option value="">Selecione um conjunto salvo...</option>';
    
    // Adicionar conjuntos locais
    if (filterType === 'todos' || filterType === 'local') {
      const localSets = this.savedValueSets[configId]?.[method]?.[path] || [];
      localSets.forEach(savedSet => {
        const option = document.createElement('option');
        option.value = `local-${savedSet.id}`;
        option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()}) [Local]`;
        select.appendChild(option);
      });
    }
    
    // Adicionar conjuntos do banco de dados
    if (filterType === 'todos' || filterType === 'database') {
      try {
        const config = this.configs.find(c => c.id === configId);
        if (config && (config.databaseName || config.gcpSecretName)) {
          const dbName = config.databaseName || config.gcpSecretName;
          const databaseSets = await invoke<Array<any>>('list_postgres_value_sets', {
            secretName: dbName,
            configId
          });
          
          // Filtrar apenas os conjuntos deste endpoint
          const endpointDatabaseSets = databaseSets.filter(set => 
            set.endpoint?.method === method && set.endpoint?.path === path
          );
          
          endpointDatabaseSets.forEach(savedSet => {
            const option = document.createElement('option');
            option.value = `database-${savedSet.id}`;
            const userInfo = savedSet.userAccount ? ` [${savedSet.userAccount}]` : '';
            option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()}) [Banco de Dados]${userInfo}`;
            select.appendChild(option);
          });
        }
      } catch (error) {
        console.error('Failed to load database value sets:', error);
        // Não mostrar erro ao usuário, apenas não carregar os conjuntos do banco de dados
      }
    }
    
    // Ocultar indicador de carregamento
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }
  }

  private async deleteValueSet(method: string, path: string, configId: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    const selectedId = select?.value;
    
    if (!selectedId) {
      this.showToast('Por favor, selecione um conjunto para excluir.', 'error');
      return;
    }

    // Verificar se é um conjunto do banco de dados ou local
    const isDatabaseSet = selectedId.startsWith('database-');
    
    if (isDatabaseSet) {
      this.showToast('Conjuntos do banco de dados não podem ser excluídos diretamente. Use o console PostgreSQL para gerenciar os registros.', 'error');
      return;
    }

    const actualId = isDatabaseSet ? selectedId.substring(9) : selectedId.substring(6); // Remove "database-" ou "local-"
    const savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === actualId);
    
    if (!savedSet) {
      this.showToast('Conjunto não encontrado.', 'error');
      return;
    }

    // Diálogo de confirmação
    const confirmed = await this.showConfirmDialog(`Tem certeza que deseja excluir o conjunto "${savedSet.name}"? Esta ação não pode ser desfeita.`);
    
    if (!confirmed) {
      return;
    }

    // Remover o conjunto
    const sets = this.savedValueSets[configId][method][path];
    const index = sets.findIndex(set => set.id === actualId);
    
    if (index !== -1) {
      sets.splice(index, 1);
      
      // Salvar no app_data_dir
      await this.saveSavedValueSets();
      
      // Limpar o input do nome se estava preenchido com o nome do conjunto excluído
      const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
      if (nameInput?.value === savedSet.name) {
        nameInput.value = '';
      }
      
      // Atualizar o select
      this.updateSavedSetsSelect(method, path, configId);
      
      this.showToast(`Conjunto "${savedSet.name}" excluído com sucesso!`, 'success');
    }
  }

  private attachResultEventListeners(method: string, path: string, configId: string, _pathParams: Record<string, string>, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string, sentUuid?: string) {
    // Event listeners para salvar teste (local e banco de dados)
    const saveBtns = document.querySelectorAll(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].save-result-btn`) as NodeListOf<HTMLButtonElement>;
    saveBtns.forEach(saveBtn => {
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const saveType = saveBtn.dataset.saveType as 'local' | 'database';
          await this.saveTestResult(method, path, configId, queryParams, body, response, timestamp, saveType, sentUuid);
        });
      }
    });

    // Event listener para exibir histórico
    const historyBtn = document.querySelector(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].show-history-btn`) as HTMLButtonElement;
    if (historyBtn) {
      historyBtn.addEventListener('click', () => {
        this.showHistoryModal(configId);
      });
    }
  }

  private setupResponseSearch(method: string, path: string, _configId: string) {
    // Event listeners para busca específica da resposta
    // Usar a mesma lógica de geração de pathId do executeTest
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // IDs esperados
    const expectedSearchInputId = `response-search-${pathId}`;
    const expectedResponseContainerId = `response-${pathId}`;
    const expectedSearchInfoId = `response-search-info-${pathId}`;
    
    // Tentar encontrar os elementos
    const searchInput = document.getElementById(expectedSearchInputId) as HTMLInputElement;
    const clearBtn = document.querySelector(`[data-search-input="${expectedSearchInputId}"]`) as HTMLButtonElement;
    const responseContainer = document.getElementById(expectedResponseContainerId) as HTMLPreElement;
    const searchInfo = document.getElementById(expectedSearchInfoId) as HTMLDivElement;

    if (searchInput && clearBtn && responseContainer && searchInfo) {
      let currentMatchIndex = 0;
      let matches: HTMLElement[] = [];
      let originalContent = responseContainer.innerHTML;

      const performSearch = () => {
        const searchTerm = searchInput.value.trim();
        
        if (!searchTerm) {
          this.clearResponseHighlights(responseContainer, originalContent);
          searchInfo.textContent = '';
          matches = [];
          currentMatchIndex = 0;
          return;
        }

        const content = responseContainer.textContent || '';
        const searchRegex = new RegExp(searchTerm, 'gi');
        
        if (searchRegex.test(content)) {
          this.highlightResponseMatches(responseContainer, searchTerm, currentMatchIndex);
          matches = Array.from(responseContainer.querySelectorAll('.response-highlight'));
          searchInfo.textContent = matches.length > 0 ? `${currentMatchIndex + 1} de ${matches.length}` : 'Nenhum resultado';
        } else {
          this.clearResponseHighlights(responseContainer, originalContent);
          searchInfo.textContent = 'Nenhum resultado';
          matches = [];
        }
      };

      const navigateResults = (direction: number) => {
        if (matches.length === 0) return;
        
        currentMatchIndex = (currentMatchIndex + direction + matches.length) % matches.length;
        searchInfo.textContent = `${currentMatchIndex + 1} de ${matches.length}`;
        this.scrollToResponseMatch(matches[currentMatchIndex]);
      };

      // Event listeners
      searchInput.addEventListener('input', performSearch);
      
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            navigateResults(-1);
          } else {
            navigateResults(1);
          }
        } else if (e.key === 'Escape') {
          searchInput.value = '';
          performSearch();
        }
      });

      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        performSearch();
        searchInput.focus();
      });
    }
  }

  private async saveTestResult(method: string, path: string, configId: string, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string, saveType: 'local' | 'database' = 'local', sentUuid?: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const nameInput = document.getElementById(`result-name-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este resultado.', 'error');
      return;
    }

    // Coletar path params atuais
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

    // Criar o resultado salvo
    const savedResult: SavedResult = {
      id: Date.now().toString(),
      name,
      endpoint: {
        method,
        path,
        configId
      },
      request: {
        pathParams,
        queryParams,
        body,
        sentUuid // UUID enviado no header da requisição
      },
      response: {
        status: response.status || 200,
        statusText: response.statusText || 'OK',
        headers: response.headers || {},
        data: response.data
      },
      timestamp,
      storageLocation: saveType
    };

    if (saveType === 'database') {
      // Salvar no banco de dados
      const config = this.configs.find(c => c.id === configId);
      const dbName = config?.databaseName || config?.gcpSecretName;
      if (!config || !dbName) {
        this.showToast('Configuração não possui banco de dados configurado.', 'error');
        return;
      }

      try {
        // Usar usuário cacheado ou obter se não disponível
        let userAccount = this.cachedGcloudUser;
        if (!userAccount) {
          userAccount = await invoke<string>('get_gcloud_account');
          this.cachedGcloudUser = userAccount; // Atualizar cache
        }
        
        // Adicionar informação do usuário ao resultado
        savedResult.userAccount = userAccount;

        // Salvar no banco de dados
        await invoke<string>('save_to_postgres', {
          secretName: dbName,
          configId,
          endpointMethod: method,
          endpointPath: path,
          resultData: savedResult
        });

        this.showToast(`Resultado salvo no banco de dados "${dbName}" com sucesso!`, 'success');
        
        // Refresh history modal if it's open
        const historyModal = document.querySelector('.history-modal') as HTMLElement;
        if (historyModal) {
          const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
          const searchInput = document.getElementById('history-search-input') as HTMLInputElement;
          const searchFilter = searchInput?.value || '';
          const endpointFilter = select?.value || '';
          const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
          const sourceFilter = sourceSelect?.value || 'todos';
          await this.displayHistoryResults(configId, endpointFilter, searchFilter, '', sourceFilter);
        }
      } catch (error) {
        console.error('Failed to save to PostgreSQL database:', error);
        this.showToast(`Erro ao salvar no banco de dados: ${String(error)}`, 'error');
      }
    } else {
      // Salvar localmente (código existente)
      if (!this.savedResults[configId]) {
        this.savedResults[configId] = [];
      }

      this.savedResults[configId].push(savedResult);
      await this.saveSavedResults();
      this.showToast('Resultado salvo localmente com sucesso!', 'success');
      
      // Refresh history modal if it's open
      const historyModal = document.querySelector('.history-modal') as HTMLElement;
      if (historyModal) {
        const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
        const searchInput = document.getElementById('history-search-input') as HTMLInputElement;
        const searchFilter = searchInput?.value || '';
        const endpointFilter = select?.value || '';
        const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
        const sourceFilter = sourceSelect?.value || 'todos';
        await this.displayHistoryResults(configId, endpointFilter, searchFilter, '', sourceFilter);
      }
    }
  }

  private showHistoryModal(configId: string) {
    // Criar modal de histórico
    const modal = document.createElement('div');
    modal.className = 'history-modal modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Histórico de Resultados</h2>
          <button class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <div class="history-controls-row">
            <div class="history-control-group">
              <label for="history-endpoint-select">Selecione o endpoint:</label>
              <select id="history-endpoint-select" class="history-endpoint-select">
                <option value="">Todos os endpoints</option>
              </select>
            </div>
            <div class="history-control-group">
              <label for="history-user-select">Filtrar por usuário:</label>
              <select id="history-user-select" class="history-user-select">
                <option value="">Todos os usuários</option>
              </select>
            </div>
            <div class="history-control-group">
              <label for="history-source-select">Origem do histórico:</label>
              <select id="history-source-select" class="history-source-select">
                <option value="todos">Todos</option>
                <option value="local">Apenas local</option>
                <option value="database">Apenas banco de dados</option>
              </select>
            </div>
          </div>
          <div class="history-controls">
            <label for="history-search-input">Buscar nos resultados:</label>
            <div class="history-search-container">
              <input type="text" 
                     id="history-search-input" 
                     class="history-search-input" 
                     placeholder="Buscar no nome, endpoint ou conteúdo...">
              <button class="history-search-clear" title="Limpar busca">×</button>
            </div>
            <div class="history-search-info" id="history-search-info"></div>
          </div>
          <div class="history-list">
            <div class="empty-state">Nenhum resultado salvo ainda.</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    // Preencher select de endpoints
    this.populateHistoryEndpoints(configId);

    // Adicionar event listeners
    this.setupHistoryModalListeners(modal, configId);

    // Mostrar modal
    setTimeout(() => {
      modal.classList.remove('hidden');
    }, 10);
  }

  private async populateHistoryEndpoints(configId: string) {
    const endpointSelect = document.getElementById('history-endpoint-select') as HTMLSelectElement;
    const userSelect = document.getElementById('history-user-select') as HTMLSelectElement;
    
    if (!endpointSelect || !userSelect) return;

    // Mostrar indicadores de carregamento nos selects
    endpointSelect.innerHTML = '<option value="">Carregando...</option>';
    userSelect.innerHTML = '<option value="">Carregando...</option>';
    
    // Coletar endpoints e usuários de TODOS os resultados (locais + banco de dados)
    const config = this.configs.find(c => c.id === configId);
    const allResults: SavedResult[] = [];
    const endpoints = new Set<string>();
    const users = new Set<string>();
    
    // Adicionar resultados locais
    const localResults = this.savedResults[configId] || [];
    allResults.push(...localResults.map(r => ({ ...r, storageLocation: 'local' as const })));
    
    // Adicionar resultados do banco de dados se configurado
    const dbName = config?.databaseName || config?.gcpSecretName;
    if (config && dbName) {
      try {
        const databaseResults = await invoke<SavedResult[]>('list_postgres_results', {
          secretName: dbName,
          configId
        });
        
        // Marcar resultados do banco de dados
        const databaseResultsWithLocation = databaseResults.map(r => ({ 
          ...r, 
          storageLocation: 'database' as const,
          userAccount: r.userAccount || 'unknown'
        }));
        
        allResults.push(...databaseResultsWithLocation);
      } catch (error) {
        console.error('Failed to load database results:', error);
        // Não mostrar erro ao usuário, apenas não incluir resultados do banco de dados
      }
    }
    
    // Coletar endpoints e usuários únicos de TODOS os resultados
    let currentUserGcloudAccount: string | null = null;
    
    // Obter conta gcloud atual para resultados locais
    try {
      currentUserGcloudAccount = await this.getCurrentUserName();
    } catch (error) {
      console.warn('Could not get current gcloud account:', error);
    }
    
    allResults.forEach(result => {
      const endpointKey = `${result.endpoint.method} ${result.endpoint.path}`;
      endpoints.add(endpointKey);
      
      // Para resultados locais, usar a conta gcloud atual como usuário
      // Para resultados do banco de dados, usar o userAccount salvo
      const userAccount = result.storageLocation === 'local' 
        ? currentUserGcloudAccount 
        : result.userAccount;
        
      if (userAccount) {
        users.add(userAccount);
      }
    });
    
    // Popular select de endpoints
    endpointSelect.innerHTML = '<option value="">Todos os endpoints</option>';
    endpoints.forEach(endpoint => {
      const option = document.createElement('option');
      option.value = endpoint;
      option.textContent = endpoint;
      endpointSelect.appendChild(option);
    });
    
    // Popular select de usuários
    userSelect.innerHTML = '<option value="">Todos os usuários</option>';
    
    // Adicionar usuários em ordem alfabética
    const sortedUsers = Array.from(users).filter(user => user && user !== 'desconhecido').sort();
    sortedUsers.forEach(user => {
      const option = document.createElement('option');
      option.value = user;
      option.textContent = `👤 ${user}`;
      userSelect.appendChild(option);
    });
  }

  private getCurrentUserName(): Promise<string> {
    // Retornar valor cacheado se disponível
    if (this.cachedGcloudUser) {
      return Promise.resolve(this.cachedGcloudUser);
    }
    
    // Fallback: tentar obter o nome do usuário atual do sistema
    try {
      return invoke<string>('get_gcloud_account');
    } catch (error) {
      console.warn('Could not get current user:', error);
      return Promise.resolve('desconhecido');
    }
  }

  private async setupHistoryModalListeners(modal: HTMLElement, configId: string) {
    // Fechar modal
    const closeBtn = modal.querySelector('.close-btn') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => {
      this.closeHistoryModal(modal);
    });

    // Fechar clicando fora
    modal.addEventListener('click', async (e) => {
      if (e.target === modal) {
        await this.closeHistoryModal(modal);
      }
    });

    // Event listeners para os campos de filtro
    const searchInput = modal.querySelector('#history-search-input') as HTMLInputElement;
    const clearBtn = modal.querySelector('.history-search-clear') as HTMLButtonElement;
    const endpointSelect = modal.querySelector('#history-endpoint-select') as HTMLSelectElement;
    const userSelect = modal.querySelector('#history-user-select') as HTMLSelectElement;
    const sourceSelect = modal.querySelector('#history-source-select') as HTMLSelectElement;
    
    if (searchInput && clearBtn && endpointSelect && userSelect && sourceSelect) {
      const performHistorySearch = async () => {
        const searchFilter = searchInput.value.trim();
        const endpointFilter = endpointSelect.value;
        const userFilter = userSelect.value;
        const sourceFilter = sourceSelect.value;
        await this.displayHistoryResults(configId, endpointFilter, searchFilter, userFilter, sourceFilter);
        
        // Re-adicionar listeners para os novos botões
        this.attachCopyButtonsListeners();
        this.attachDeleteButtonListeners(modal);
        this.setupHistoryResponseSearchListeners();
      };

      // Event listeners para busca e usuário
      searchInput.addEventListener('input', performHistorySearch);
      userSelect.addEventListener('change', performHistorySearch);
      sourceSelect.addEventListener('change', performHistorySearch);
      
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          performHistorySearch();
        }
      });

      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        performHistorySearch();
        searchInput.focus();
      });
    }

    // Exibir todos os resultados inicialmente
    await this.displayHistoryResults(configId, '', '', '', 'todos');
    
    // Adicionar event listeners para os botões de copiar
    this.attachCopyButtonsListeners();
    
    // Adicionar event listeners para os botões de exclusão
    this.attachDeleteButtonListeners(modal);

    // Adicionar event listeners para busca individual em cada resultado
    this.setupHistoryResponseSearchListeners();
  }

  private setupHistoryResponseSearchListeners() {
    // Configurar busca para cada resultado individual no histórico
    const searchInputs = document.querySelectorAll('.history-response-search-input') as NodeListOf<HTMLInputElement>;
    
    searchInputs.forEach(searchInput => {
      const resultId = searchInput.id.replace('history-response-search-', '');
      const clearBtn = document.querySelector(`[data-search-input="history-response-search-${resultId}"]`) as HTMLButtonElement;
      const responseContainer = document.getElementById(`history-response-${resultId}`) as HTMLPreElement;
      const searchInfo = document.getElementById(`history-response-search-info-${resultId}`) as HTMLDivElement;

      if (clearBtn && responseContainer && searchInfo) {
        let currentMatchIndex = 0;
        let matches: HTMLElement[] = [];
        let originalContent = responseContainer.innerHTML;

        const performSearch = () => {
          const searchTerm = searchInput.value.trim();
          
          if (!searchTerm) {
            // Restaurar conteúdo original
            responseContainer.innerHTML = originalContent;
            searchInfo.textContent = '';
            matches = [];
            currentMatchIndex = 0;
            return;
          }

          const content = responseContainer.textContent || '';
          const searchRegex = new RegExp(searchTerm, 'gi');
          
          if (searchRegex.test(content)) {
            // Salvar conteúdo original se ainda não foi salvo
            if (!responseContainer.dataset.originalContent) {
              responseContainer.dataset.originalContent = originalContent;
            }
            
            // Aplicar highlights
            this.highlightResponseMatches(responseContainer, searchTerm, currentMatchIndex);
            matches = Array.from(responseContainer.querySelectorAll('.response-highlight'));
            searchInfo.textContent = matches.length > 0 ? `${currentMatchIndex + 1} de ${matches.length}` : 'Nenhum resultado';
          } else {
            // Restaurar conteúdo original
            if (responseContainer.dataset.originalContent) {
              responseContainer.innerHTML = responseContainer.dataset.originalContent;
            }
            searchInfo.textContent = 'Nenhum resultado';
            matches = [];
          }
        };

        searchInput.addEventListener('input', performSearch);
        clearBtn.addEventListener('click', () => {
          searchInput.value = '';
          performSearch();
          searchInput.focus();
        });
      }
    });
  }

  private async closeHistoryModal(modal: HTMLElement) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    setTimeout(() => {
      document.body.removeChild(modal);
    }, 300);
  }

  private async displayHistoryResults(configId: string, endpointFilter: string, searchFilter: string = '', userFilter: string = '', sourceFilter: string = 'todos') {
    const listContainer = document.querySelector('.history-list') as HTMLElement;
    if (!listContainer) return;

    // Garantir que o usuário atual esteja carregado
    if (!this.cachedGcloudUser) {
      try {
        await this.loadGcloudUser();
      } catch (error) {
        console.warn('Could not load gcloud user:', error);
      }
    }

    // Mostrar indicador de carregamento
    listContainer.innerHTML = `
      <div class="history-loading">
        <div class="loading-spinner"></div>
        <p>Carregando resultados...</p>
      </div>
    `;

    const config = this.configs.find(c => c.id === configId);
    let allResults: SavedResult[] = [];

    // Adicionar resultados locais (apenas se sourceFilter for 'todos' ou 'local')
    if (sourceFilter === 'todos' || sourceFilter === 'local') {
      const localResults = this.savedResults[configId] || [];
      allResults.push(...localResults.map(r => ({ ...r, storageLocation: r.storageLocation || 'local' as const })));
    }

    // Adicionar resultados do banco de dados se configurado (apenas se sourceFilter for 'todos' ou 'database')
    if ((sourceFilter === 'todos' || sourceFilter === 'database') && config && config.databaseName) {
      try {
        const databaseResults = await invoke<SavedResult[]>('list_postgres_results', {
          secretName: config.databaseName,
          configId
        });
        
        // Marcar resultados do banco de dados
        const databaseResultsWithLocation = databaseResults.map(r => ({ 
          ...r, 
          storageLocation: 'database' as const,
          userAccount: r.userAccount || 'unknown'
        }));
        
        allResults.push(...databaseResultsWithLocation);
      } catch (error) {
        console.error('Failed to load database results:', error);
        // Não mostrar erro ao usuário, apenas não incluir resultados do banco de dados
      }
    }

    // Filtrar por endpoint se necessário
    let filteredResults = endpointFilter 
      ? allResults.filter(result => `${result.endpoint.method} ${result.endpoint.path}` === endpointFilter)
      : allResults;

    // Filtrar por termo de busca se necessário
    if (searchFilter) {
      const searchLower = searchFilter.toLowerCase();
      filteredResults = filteredResults.filter(result => {
        // Buscar no nome
        if (result.name.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no endpoint
        const endpointKey = `${result.endpoint.method} ${result.endpoint.path}`;
        if (endpointKey.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no conteúdo da resposta
        const responseContent = typeof result.response.data === 'string' 
          ? result.response.data 
          : JSON.stringify(result.response.data);
        if (responseContent.toLowerCase().includes(searchLower)) return true;
        
        // Buscar nos query params
        if (result.request.queryParams) {
          const queryParamsStr = JSON.stringify(result.request.queryParams);
          if (queryParamsStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar nos path params
        if (result.request.pathParams) {
          const pathParamsStr = JSON.stringify(result.request.pathParams);
          if (pathParamsStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar no UUID enviado
        if (result.request.sentUuid && result.request.sentUuid.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no body
        if (result.request.body && result.request.body.toLowerCase().includes(searchLower)) return true;
        
        // Buscar nos headers
        if (result.response.headers) {
          const headersStr = JSON.stringify(result.response.headers);
          if (headersStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar na conta do usuário (para resultados do banco de dados)
        if (result.userAccount && result.userAccount.toLowerCase().includes(searchLower)) return true;
        
        return false;
      });
    }

    // Filtrar por usuário se necessário
    if (userFilter) {
      // Obter conta gcloud atual para comparar com resultados locais
      let currentUserGcloudAccount: string | null = null;
      try {
        currentUserGcloudAccount = await this.getCurrentUserName();
      } catch (error) {
        console.warn('Could not get current gcloud account for filtering:', error);
      }
      
      filteredResults = filteredResults.filter(result => {
        // Para resultados locais, mostrar apenas se o filtro corresponder à conta gcloud atual
        if (result.storageLocation === 'local') {
          return currentUserGcloudAccount === userFilter;
        }
        
        // Para resultados do banco de dados, verificar userAccount
        if (result.storageLocation === 'database' && result.userAccount) {
          return result.userAccount === userFilter;
        }
        
        // Se não houver correspondência, não mostrar
        return false;
      });
    }

    // Ordenar do mais recente para o mais antigo
    const sortedResults = filteredResults.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (sortedResults.length === 0) {
      const emptyMessage = searchFilter 
        ? `Nenhum resultado encontrado para "${searchFilter}".`
        : endpointFilter 
          ? 'Nenhum resultado encontrado para este endpoint.'
          : 'Nenhum resultado encontrado.';
      listContainer.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
      
      // Atualizar contador de resultados
      const searchInfo = document.getElementById('history-search-info') as HTMLDivElement;
      if (searchInfo) {
        searchInfo.textContent = searchFilter ? `0 resultados` : '';
      }
      return;
    }

    // Destacar o termo de busca nos resultados
    const highlightSearchTerm = (text: string) => {
      if (!searchFilter) return this.escapeHtml(text);
      
      // Função para escapar caracteres especiais na regex
      const escapeRegex = (str: string): string => {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      };
      
      const escapedSearchFilter = escapeRegex(searchFilter);
      const regex = new RegExp(`(${escapedSearchFilter})`, 'gi');
      return this.escapeHtml(text).replace(regex, '<span class="history-search-highlight">$1</span>');
    };

    listContainer.innerHTML = sortedResults.map(result => `
      <div class="history-item collapsed" data-result-id="${result.id}" data-storage-location="${result.storageLocation || 'local'}">
        <div id="result-name-${result.id}" style="display: none;">${this.escapeHtml(result.name)}</div>
        <div class="history-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="history-title">
            <div class="title-with-copy">
              <h4>${highlightSearchTerm(result.name)}</h4>
              <button class="copy-btn copy-title-btn" data-target="result-name-${result.id}" title="Copiar nome do resultado" onclick="event.stopPropagation()">❐</button>
            </div>
            <div class="history-meta">
              <span class="history-endpoint">${highlightSearchTerm(`${result.endpoint.method} ${result.endpoint.path}`)}</span>
              <span class="history-timestamp">${new Date(result.timestamp).toLocaleString('pt-BR')}</span>
              ${result.storageLocation === 'database' ? `
                <span class="history-storage-indicator database" title="Salvo no banco de dados">
                  ▤ Banco de Dados
                </span>
                ${result.userAccount ? `
                  <span class="history-user" title="Salvo por: ${result.userAccount}">
                    👤 ${highlightSearchTerm(result.userAccount)}
                  </span>
                ` : ''}
              ` : `
                <span class="history-storage-indicator local" title="Salvo localmente">
                  💻 Local
                </span>
              `}
            </div>
          </div>
          <div class="history-actions">
            ${result.storageLocation === 'local' || (result.storageLocation === 'database' && (result.userAccount === 'unknown' || result.userAccount === this.cachedGcloudUser)) ? `
              <button 
                class="delete-result-btn" 
                data-result-id="${result.id}"
                data-config-id="${configId}"
                data-storage-location="${result.storageLocation}"
                data-user-account="${result.userAccount || ''}"
                title="Excluir resultado"
              >
                🗑️
              </button>
            ` : `
              <span class="database-result-info" title="Resultados do banco de dados só podem ser excluídos pelo criador">
                ▤
              </span>
            `}
            <span class="history-expand-icon">▶</span>
          </div>
        </div>
        <div class="history-content">
          <div class="history-content-inner">
            <div class="history-request">
              <h5>Request:</h5>
              ${result.request.pathParams && Object.keys(result.request.pathParams).length > 0 ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Path Params:</strong></p>
                    <button class="copy-btn" data-target="history-path-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-path-${result.id}">${this.escapeHtml(JSON.stringify(result.request.pathParams, null, 2))}</pre>
                </div>
              ` : ''}
              ${result.request.queryParams && Object.keys(result.request.queryParams).length > 0 ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Query Params:</strong></p>
                    <button class="copy-btn" data-target="history-query-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-query-${result.id}">${this.escapeHtml(JSON.stringify(result.request.queryParams, null, 2))}</pre>
                </div>
              ` : ''}
              ${result.request.sentUuid ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>UUID Enviado:</strong></p>
                    <button class="copy-btn" data-target="history-uuid-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-uuid-${result.id}">${this.escapeHtml(result.request.sentUuid)}</pre>
                </div>
              ` : ''}
              ${result.request.body ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Body:</strong></p>
                    <button class="copy-btn" data-target="history-body-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-body-${result.id}">${this.escapeHtml(result.request.body)}</pre>
                </div>
              ` : ''}
            </div>
            <div class="history-response">
              <h5>Response (${result.response.status} ${result.response.statusText}):</h5>
              <div class="history-section">
                <div class="section-header">
                  <p><strong>Dados:</strong></p>
                  <button class="copy-btn" data-target="history-response-${result.id}">📋 Copiar</button>
                </div>
                <div class="history-response-search-container">
                  <div class="history-response-search-header">
                    <input type="text" 
                           id="history-response-search-${result.id}" 
                           class="history-response-search-input" 
                           placeholder="Buscar nesta resposta..." 
                           data-response-id="history-response-${result.id}">
                    <button class="history-response-search-clear" data-search-input="history-response-search-${result.id}" title="Limpar busca">×</button>
                  </div>
                  <div class="history-response-search-info" id="history-response-search-info-${result.id}"></div>
                </div>
                <pre id="history-response-${result.id}">${this.escapeHtml(typeof result.response.data === 'string' ? result.response.data : JSON.stringify(result.response.data, null, 2))}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    // Atualizar contador de resultados
    const searchInfo = document.getElementById('history-search-info') as HTMLDivElement;
    if (searchInfo) {
      searchInfo.textContent = searchFilter ? `${sortedResults.length} resultado${sortedResults.length !== 1 ? 's' : ''}` : '';
    }
  }

  private async executeTest(method: string, path: string, configId: string) {
    const config = this.configs.find(c => c.id === configId);
    if (!config) return;

    // Coletar path params e substituir na URL
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

    // Substituir path parameters na URL
    let processedPath = path;
    Object.entries(pathParams).forEach(([param, value]) => {
      processedPath = processedPath.replace(`{${param}}`, encodeURIComponent(value));
    });

    // Coletar query params
    const queryParams: Record<string, string> = {};
    document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        queryParams[param] = value;
      }
    });

    // Coletar body
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';
    
    const testResult = document.getElementById(`test-result-${method}-${pathId}`);
    if (!testResult) return;
    
    testResult.innerHTML = '<div class="test-loading">Executando teste...</div>';

    try {
      const baseUrl = config.url ? config.url.replace(/\/$/, '') : '';
      const queryString = Object.keys(queryParams).length > 0 
        ? '?' + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';
      
      const fullUrl = `${baseUrl}${processedPath}${queryString}`;

      // Processar headers personalizados com suporte a UUID
      const processedHeaders: Record<string, string> = {};
      let sentUuid: string | undefined; // Capturar UUID enviado no header
      
      if (config.headers && config.headers.length > 0) {
        config.headers.forEach(header => {
          if (header.name && header.value) {
            // Se o valor for exatamente "uuid", gerar um UUID
            if (header.value.toLowerCase() === 'uuid') {
              const uuid = this.generateUUID();
              processedHeaders[header.name] = uuid;
              sentUuid = uuid; // Armazenar UUID enviado
            } else {
              processedHeaders[header.name] = header.value;
            }
          }
        });
      }

      // Usar o proxy Tauri para fazer a requisição com autenticação e headers
      const response: TestResponse = await invoke('make_test_request', {
        url: fullUrl,
        method: method.toUpperCase(),
        body: body,
        useAuth: config.useDefaultAuth,
        headers: processedHeaders
      });

      const timestamp = new Date().toISOString();
      const hasData = response.data && (typeof response.data === 'object' && Object.keys(response.data).length > 0 || typeof response.data === 'string' && response.data.trim());

      testResult.innerHTML = `
        <div class="test-result success">
          <div class="test-status">
            <div class="test-status-header">
              <h5>Resposta ${response.status || 200} ${response.statusText || 'OK'}</h5>
              ${hasData ? `
                <div class="test-result-actions">
                  <input 
                    type="text" 
                    id="result-name-${pathId}"
                    class="result-name-input"
                    placeholder="Nome do resultado..."
                    value="Resultado_${new Date().toLocaleString('pt-BR').replace(/[^\w]/g, '_')}"
                  />
                  <div class="save-buttons-row">
                    <button 
                      class="save-result-btn save-local-btn" 
                      data-method="${method}"
                      data-path="${path}"
                      data-config-id="${configId}"
                      data-timestamp="${timestamp}"
                      data-save-type="local"
                    >
                      Salvar local
                    </button>
                    ${config.databaseName && !config.isPrivate ? `
                    <button 
                      class="save-result-btn save-database-btn" 
                      data-method="${method}"
                      data-path="${path}"
                      data-config-id="${configId}"
                      data-timestamp="${timestamp}"
                      data-save-type="database"
                      title="Salvar no banco de dados"
                    >
                      Salvar no banco de dados
                    </button>
                    ` : ''}
                  </div>
                  <button 
                    class="show-history-btn" 
                    data-method="${method}"
                    data-path="${path}"
                    data-config-id="${configId}"
                  >
                    Exibir Histórico
                  </button>
                </div>
              ` : ''}
            </div>
            <p><strong>URL:</strong> ${this.escapeHtml(fullUrl)}</p>
            ${response.headers ? `
              <div class="test-headers-section">
                <details>
                  <summary>Response Headers</summary>
                  <div class="headers-data-wrapper">
                    <pre id="headers-${method}-${pathId}" class="test-headers">${this.escapeHtml(JSON.stringify(response.headers, null, 2))}</pre>
                    <button class="copy-btn" data-target="headers-${method}-${pathId}">📋 Copiar</button>
                  </div>
                </details>
              </div>
            ` : ''}
            ${body ? `
              <div class="test-body-section">
                <div class="section-header">
                  <p><strong>Body enviado:</strong></p>
                  <button class="copy-btn" data-target="body-${method}-${pathId}">📋 Copiar</button>
                </div>
                <pre id="body-${method}-${pathId}" class="test-body">${this.escapeHtml(body)}</pre>
              </div>
            ` : ''}
          </div>
          <div class="test-response">
            <details open>
              <summary>Resposta</summary>
              <div class="response-search-container">
                <div class="response-search-header">
                  <input type="text" 
                         id="response-search-${pathId}" 
                         class="response-search-input" 
                         placeholder="Buscar na resposta..." 
                         data-response-id="response-${pathId}">
                  <button class="response-search-clear" data-search-input="response-search-${pathId}" title="Limpar busca">×</button>
                </div>
                <div class="response-search-info" id="response-search-info-${pathId}"></div>
              </div>
              <div class="response-data-wrapper">
                <pre id="response-${pathId}" class="test-response-data">${this.escapeHtml(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2))}</pre>
                <button class="copy-btn" data-target="response-${pathId}">📋 Copiar</button>
              </div>
            </details>
          </div>
        </div>
      `;

      // Configurar event listeners para busca SEMPRE (independentemente de ter dados para salvar)
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.setupResponseSearch(method, path, configId);
        }, 50);
      });

      // Adicionar event listeners para os novos botões (apenas se houver dados)
      if (hasData) {
        this.attachResultEventListeners(method, path, configId, pathParams, queryParams, body, response, timestamp, sentUuid);
      }

      // Adicionar event listeners para os botões de copiar
      this.attachCopyButtonsListeners();

    } catch (error) {
      console.error('Erro na requisição:', error);
      testResult.innerHTML = `
        <div class="test-error">
          <h5>Erro na requisição</h5>
          <pre>${this.escapeHtml(String(error))}</pre>
        </div>
      `;
    }
  }

  private generateTestInterface(method: string, details: any, path: string, spec: any, configId: string): string {
    const queryParams = details.parameters?.filter((param: any) => param.in === 'query') || [];
    const pathParams = details.parameters?.filter((param: any) => param.in === 'path') || [];
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
    const exampleBody = this.generateExampleBody(details, spec);
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // Verificar se há algo para salvar (path params, query params ou body)
    const hasAnythingToSave = pathParams.length > 0 || queryParams.length > 0 || hasBody;
    
    // Armazenar valor padrão no mapa
    const bodyKey = `${method}-${pathId}`;
    this.defaultBodyValues.set(bodyKey, exampleBody);

    return `
      <div class="test-interface">
        ${pathParams.length > 0 ? `
          <div class="path-params">
            <div class="section-header">
              <h6>Path Parameters:</h6>
              <button class="reset-btn" data-reset="path-${method}-${pathId}" title="Resetar Path Params">🔄</button>
            </div>
            ${pathParams.map((param: any) => `
              <div class="param-input">
                <label for="path-param-${param.name}-${pathId}">
                  ${this.escapeHtml(param.name)} ${param.required ? '<span class="required">*</span>' : ''}
                </label>
                <input 
                  type="text" 
                  id="path-param-${param.name}-${pathId}"
                  data-path-param="${method}-${pathId}"
                  data-param="${param.name}"
                  data-default="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  placeholder="${this.escapeHtml(param.description || `Digite ${param.name}...`)}"
                  value="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  ${param.required ? 'required' : ''}
                />
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${queryParams.length > 0 ? `
          <div class="query-params">
            <div class="section-header">
              <h6>Query Parameters:</h6>
              <button class="reset-btn" data-reset="query-${method}-${pathId}" title="Resetar Query Params">🔄</button>
            </div>
            ${queryParams.map((param: any) => `
              <div class="param-input">
                <label for="param-${param.name}-${pathId}">
                  ${this.escapeHtml(param.name)} ${param.required ? '<span class="required">*</span>' : ''}
                </label>
                <input 
                  type="text" 
                  id="param-${param.name}-${pathId}"
                  data-query-param="${method}-${pathId}"
                  data-param="${param.name}"
                  data-default="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  placeholder="${this.escapeHtml(param.description || `Digite ${param.name}...`)}"
                  value="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  ${param.required ? 'required' : ''}
                />
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${hasBody ? `
          <div class="body-input">
            <div class="section-header">
              <h6>Body (JSON):</h6>
              <button class="reset-btn" data-reset="body-${method}-${pathId}" title="Resetar Body">🔄</button>
            </div>
            <textarea 
              id="body-${method}-${pathId}"
              class="body-textarea"
              placeholder="Digite o JSON do corpo da requisição..."
              rows="6"
            >${this.escapeHtml(exampleBody)}</textarea>
          </div>
        ` : ''}
        
        <div class="test-actions">
          <button 
            class="test-btn" 
            data-method="${method}"
            data-path="${path}"
            data-config-id="${configId}"
          >
            Testar Endpoint
          </button>
        </div>
        
        ${hasAnythingToSave ? `
        <details class="saved-sets-section">
          <summary>Conjuntos de Valores Salvos:</summary>
          <div class="save-set-controls">
            <input 
              type="text" 
              id="save-name-${method}-${pathId}"
              placeholder="Nome do conjunto"
              class="save-name-input"
            />
            <button 
              class="save-set-btn" 
              data-method="${method}"
              data-path="${path}"
              data-config-id="${configId}"
            >
              Salvar Local
            </button>
            ${(() => {
              const config = this.configs.find(c => c.id === configId);
              return config && config.databaseName && !config.isPrivate ? `
            <button 
              class="save-set-database-btn" 
              data-method="${method}"
              data-path="${path}"
              data-config-id="${configId}"
              title="Salvar no banco de dados"
            >
              Salvar no banco de dados
            </button>
            ` : '';
            })()}
          </div>
          <div class="load-set-controls">
            <label for="saved-sets-${method}-${pathId}">Carregar conjunto:</label>
            <div class="load-set-row">
              <select 
                id="saved-sets-filter-${method}-${pathId}"
                class="saved-sets-filter"
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
              >
                <option value="todos">Todos</option>
                <option value="local">Apenas local</option>
                <option value="database">Apenas banco de dados</option>
              </select>
              <select 
                id="saved-sets-${method}-${pathId}"
                class="saved-sets-select"
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
              >
                <option value="">Selecione um conjunto salvo...</option>
              </select>
              <button 
                class="delete-set-btn" 
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
                title="Excluir conjunto selecionado"
              >
                🗑️
              </button>
              <div id="loading-${method}-${pathId}" class="loading-indicator" style="display: none;">
                <div class="loading-spinner"></div>
                Carregando...
              </div>
            </div>
          </div>
        </details>
        ` : ''}
        
        <div id="test-result-${method}-${pathId}" class="test-result-container"></div>
      </div>
    `;
  }

  private generateExampleBody(details: any, spec: any): string {
    // Tentar obter exemplo do requestBody
    if (details.requestBody?.content?.['application/json']?.example) {
      return JSON.stringify(details.requestBody.content['application/json'].example, null, 2);
    }
    
    // Tentar obter exemplo do schema
    if (details.requestBody?.content?.['application/json']?.schema) {
      return this.generateExampleFromSchema(details.requestBody.content['application/json'].schema, spec);
    }
    
    // Gerar exemplo baseado no método
    const method = details.method?.toLowerCase() || 'post';
    if (method === 'post' || method === 'put') {
      return '{\n  "key": "value"\n}';
    }
    
    return '';
  }

  private generateExampleFromSchema(schema: any, spec: any): string {
    if (schema.example) {
      return JSON.stringify(schema.example, null, 2);
    }
    
    if (schema.$ref) {
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved: any = spec;
      for (const part of refPath) {
        resolved = resolved?.[part];
      }
      if (resolved) {
        return this.generateExampleFromSchema(resolved, spec);
      }
    }
    
    if (schema.type === 'object' && schema.properties) {
      const obj: any = {};
      Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
        if (prop.example) {
          obj[key] = prop.example;
        } else if (prop.type === 'string') {
          obj[key] = prop.enum?.[0] || `string_${key}`;
        } else if (prop.type === 'number' || prop.type === 'integer') {
          obj[key] = prop.minimum || 0;
        } else if (prop.type === 'boolean') {
          obj[key] = true;
        } else if (prop.type === 'array') {
          obj[key] = [];
        } else {
          obj[key] = null;
        }
      });
      return JSON.stringify(obj, null, 2);
    }
    
    return '{}';
  }

  private getCurrentConfigId(): string {
    return this.elements.configSelect.value || '';
  }

  private async updateWindowTitle() {
    try {
      const currentConfigId = this.getCurrentConfigId();
      let title = 'EasyOpenAPI';
      
      if (currentConfigId) {
        const config = this.configs.find(c => c.id === currentConfigId);
        if (config) {
          title = `EasyOpenAPI - ${config.name}`;
        }
      }
      
      await getCurrentWindow().setTitle(title);
    } catch (error) {
      console.error('Failed to update window title:', error);
    }
  }

  private showConfirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';

      const dialog = document.createElement('div');
      dialog.style.cssText = [
        'border-radius:8px',
        'padding:24px',
        'max-width:400px',
        'width:90%',
        'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
        'font-family:inherit',
        isDark ? 'background:#212529;color:#e9ecef;border:1px solid #495057;' : 'background:#ffffff;color:#333;border:1px solid #dee2e6;'
      ].join(';');

      const msg = document.createElement('p');
      msg.textContent = message;
      msg.style.cssText = 'margin:0 0 20px;font-size:14px;line-height:1.5;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.style.cssText = [
        'padding:8px 16px',
        'border-radius:4px',
        'cursor:pointer',
        'font-size:13px',
        isDark ? 'border:1px solid #495057;background:#343a40;color:#e9ecef;' : 'border:1px solid #dee2e6;background:#f8f9fa;color:#333;'
      ].join(';');

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Excluir';
      confirmBtn.style.cssText = [
        'padding:8px 16px',
        'border-radius:4px',
        'border:none',
        'cursor:pointer',
        'font-size:13px',
        'font-weight:600',
        isDark ? 'background:#c23c3c;color:#fff;' : 'background:#dc3545;color:#fff;'
      ].join(';');

      const close = (result: boolean) => {
        document.body.removeChild(overlay);
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => close(false));
      confirmBtn.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

      actions.append(cancelBtn, confirmBtn);
      dialog.append(msg, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      confirmBtn.focus();
    });
  }

  private showToast(message: string, type: 'success' | 'error' = 'success') {
    // Criar elemento do toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // Adicionar ao DOM
    document.body.appendChild(toast);
    
    // Remover após
    // sucesso = 4 segundos
    // erro = 10 segundos
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, type == 'success' ? 4000 : 10000);
  }

  private attachCopyButtonsListeners() {
    // Event listeners para botões de copiar
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const targetId = target.dataset.target;
        
        if (targetId) {
          const element = document.getElementById(targetId);
          if (element) {
            const text = element.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
              this.showToast('Conteúdo copiado para a área de transferência!', 'success');
            }).catch(() => {
              this.showToast('Falha ao copiar conteúdo', 'error');
            });
          }
        }
      });
    });
  }

  private attachDeleteButtonListeners(modal: HTMLElement) {
    // Event listeners para botões de exclusão
    modal.querySelectorAll('.delete-result-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const target = (e.target as HTMLElement).closest('.delete-result-btn') as HTMLElement;
        if (!target) return;
        const resultId = target.dataset.resultId;
        const btnConfigId = target.dataset.configId;
        const storageLocation = target.dataset.storageLocation;
        const userAccount = target.dataset.userAccount;
        
        if (resultId && btnConfigId) {
          await this.deleteSavedResult(resultId, btnConfigId, storageLocation, userAccount);
        }
      });
    });
  }

  private async deleteSavedResult(resultId: string, configId: string, storageLocation?: string, userAccount?: string) {
    const confirmed = await this.showConfirmDialog('Tem certeza que deseja excluir este resultado salvo?');
    if (!confirmed) {
      return;
    }

    // Se for resultado do banco de dados, usar a função do backend
    if (storageLocation === 'database') {
      try {
        const config = this.configs.find(c => c.id === configId);
        const secretName = config?.databaseName || config?.gcpSecretName;
        if (!secretName) {
          this.showToast('Erro: configuração não encontrada ou sem nome do banco de dados', 'error');
          return;
        }

        const success = await invoke<boolean>('delete_test_result_from_postgres', {
          secretName,
          configId,
          resultId,
          userAccount: userAccount || 'unknown'
        });

        if (success) {
          this.showToast('Resultado do banco de dados excluído com sucesso!', 'success');
        } else {
          this.showToast('Erro ao excluir resultado do banco de dados', 'error');
          return;
        }
      } catch (error) {
        console.error('Error deleting database result:', error);
        this.showToast('Erro ao excluir resultado do banco de dados', 'error');
        return;
      }
    } else {
      // Exclusão local (comportamento original)
      const results = this.savedResults[configId] || [];
      const updatedResults = results.filter(result => result.id !== resultId);
      
      if (updatedResults.length === 0) {
        delete this.savedResults[configId];
      } else {
        this.savedResults[configId] = updatedResults;
      }
      
      this.saveSavedResults();
      this.showToast('Resultado local excluído com sucesso!', 'success');
    }
    
    // Atualizar a exibição
    const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
    const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
    await this.displayHistoryResults(configId, select?.value || '', '', '', sourceSelect?.value || 'todos');
    
    // Re-adicionar listeners após a atualização
    const modal = document.querySelector('.history-modal') as HTMLElement;
    if (modal) {
      this.attachCopyButtonsListeners();
      this.attachDeleteButtonListeners(modal);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private async loadTheme() {
    try {
      const savedTheme = localStorage.getItem(this.THEME_KEY);
      if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        this.elements.themeToggleBtn.textContent = '🌙 Tema Escuro';
      } else {
        document.documentElement.removeAttribute('data-theme');
        this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
      }
    } catch (error) {
      console.error('Failed to load theme:', error);
      // Tema padrão (light)
      document.documentElement.removeAttribute('data-theme');
      this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
    }
  }

  private async loadFontSize() {
    try {
      const savedFontSize = localStorage.getItem(this.FONT_SIZE_KEY);
      const fontSize = savedFontSize ? parseFloat(savedFontSize) : 1;
      this.setFontSize(fontSize);
      this.elements.fontSizeSelect.value = fontSize.toString();
    } catch (error) {
      console.error('Failed to load font size:', error);
      // Tamanho padrão (médio)
      this.setFontSize(1);
      this.elements.fontSizeSelect.value = '1';
    }
  }

  private setFontSize(multiplier: number) {
    document.documentElement.style.setProperty('--font-size-multiplier', multiplier.toString());
    localStorage.setItem(this.FONT_SIZE_KEY, multiplier.toString());
  }

  private toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const isDark = currentTheme === 'dark';
    
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
      localStorage.setItem(this.THEME_KEY, 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      this.elements.themeToggleBtn.textContent = '🌙 Tema Escuro';
      localStorage.setItem(this.THEME_KEY, 'dark');
    }
  }

  private handleReset(resetType: string) {
    if (resetType.startsWith('custom-path-')) {
      // Resetar path params para custom endpoints - formato: custom-path-{endpointId}
      const endpointId = resetType.replace('custom-path-', '');
      const testBtn = document.querySelector(`.test-btn[data-endpoint-id="${endpointId}"]`) as HTMLButtonElement;
      
      if (testBtn) {
        const method = testBtn.dataset.method;
        const pathId = testBtn.dataset.pathId;
        const endpointElement = document.getElementById(`endpoint-${method}-${pathId}`) as HTMLElement;
        
        if (endpointElement) {
          const pathInputs = endpointElement.querySelectorAll('.path-param-input');
          pathInputs.forEach(input => {
            (input as HTMLInputElement).value = '';
          });
        }
      }
    } else if (resetType.startsWith('custom-query-')) {
      // Resetar query params para custom endpoints - formato: custom-query-{endpointId}
      const endpointId = resetType.replace('custom-query-', '');
      const testBtn = document.querySelector(`.test-btn[data-endpoint-id="${endpointId}"]`) as HTMLButtonElement;
      
      if (testBtn) {
        const method = testBtn.dataset.method;
        const pathId = testBtn.dataset.pathId;
        const endpointElement = document.getElementById(`endpoint-${method}-${pathId}`) as HTMLElement;
        
        if (endpointElement) {
          const queryInputs = endpointElement.querySelectorAll('.query-param-input');
          queryInputs.forEach(input => {
            const htmlInput = input as HTMLInputElement;
            const defaultValue = htmlInput.dataset.default || '';
            htmlInput.value = defaultValue;
          });
        }
      }
    } else if (resetType.startsWith('custom-body-')) {
      // Resetar body para custom endpoints - formato: custom-body-{endpointId}
      const endpointId = resetType.replace('custom-body-', '');
      const testBtn = document.querySelector(`.test-btn[data-endpoint-id="${endpointId}"]`) as HTMLButtonElement;
      
      if (testBtn) {
        const method = testBtn.dataset.method;
        const pathId = testBtn.dataset.pathId;
        const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
        
        if (bodyTextarea) {
          const bodyKey = `${method}-${pathId}`;
          const defaultBody = this.defaultBodyValues.get(bodyKey) || '';
          bodyTextarea.value = defaultBody;
        }
      }
    } else if (resetType.startsWith('path-')) {
      // Resetar path params - formato: path-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const pathInputs = document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`);
      
      pathInputs.forEach(input => {
        const htmlInput = input as HTMLInputElement;
        const defaultValue = htmlInput.dataset.default || '';
        htmlInput.value = defaultValue;
      });
    } else if (resetType.startsWith('query-')) {
      // Resetar query params - formato: query-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const queryInputs = document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`);
      
      queryInputs.forEach(input => {
        const htmlInput = input as HTMLInputElement;
        const defaultValue = htmlInput.dataset.default || '';
        htmlInput.value = defaultValue;
      });
    } else if (resetType.startsWith('body-')) {
      // Resetar body - formato: body-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
      
      if (bodyTextarea) {
        const bodyKey = `${method}-${pathId}`;
        const defaultBody = this.defaultBodyValues.get(bodyKey) || '';
        bodyTextarea.value = defaultBody;
      }
    }
  }

  // Métodos para busca específica de resposta
  private clearResponseHighlights(container: HTMLElement, originalContent: string) {
    // Usar o conteúdo original salvo no dataset se disponível
    if (container.dataset.originalContent) {
      container.innerHTML = container.dataset.originalContent;
    } else {
      container.innerHTML = originalContent;
    }
  }

  private highlightResponseMatches(container: HTMLElement, searchTerm: string, currentIndex: number) {
    // Salvar o conteúdo original se ainda não foi salvo
    if (!container.dataset.originalContent) {
      container.dataset.originalContent = container.innerHTML;
    }
    
    // Restaurar conteúdo original antes de aplicar novos highlights
    container.innerHTML = container.dataset.originalContent;
    
    // Verificar se há conteúdo para buscar
    const textContent = container.textContent || '';
    if (!textContent) {
      return;
    }
    
    // Função para escapar caracteres especiais no searchTerm
    const escapeRegex = (str: string): string => {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };
    
    const escapedSearchTerm = escapeRegex(searchTerm);
    const searchRegex = new RegExp(escapedSearchTerm, 'gi');
    
    // Verificar se há matches
    if (!searchRegex.test(textContent)) {
      return;
    }
    
    // Resetar regex para uso
    searchRegex.lastIndex = 0;
    
    // Abordagem simples: usar mark.js style highlighting
    const highlightRegex2 = new RegExp(`(${escapedSearchTerm})`, 'gi');
    
    // Substituir apenas em nós de texto para evitar quebrar HTML
    // Esta é uma abordagem mais simples e robusta
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = container.innerHTML;
    
    const walker = document.createTreeWalker(
      tempDiv,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    const textNodes: Text[] = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent && highlightRegex2.test(node.textContent)) {
        textNodes.push(node as Text);
      }
      highlightRegex2.lastIndex = 0;
    }
    
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      const highlightedText = text.replace(highlightRegex2, '<span class="response-highlight">$1</span>');
      
      if (highlightedText !== text) {
        const span = document.createElement('span');
        span.innerHTML = highlightedText;
        textNode.parentNode?.replaceChild(span, textNode);
      }
    });
    
    // Adicionar classe ao match atual
    const highlights = tempDiv.querySelectorAll('.response-highlight');
    highlights.forEach((highlight, index) => {
      if (index === currentIndex) {
        highlight.classList.add('current-response-match');
      }
    });
    
    // Atualizar o container com o conteúdo destacado
    container.innerHTML = tempDiv.innerHTML;
  }

  private scrollToResponseMatch(matchElement: HTMLElement) {
    matchElement.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    
    // Remover highlight anterior e adicionar ao atual
    const container = matchElement.closest('.test-response-data');
    if (container) {
      container.querySelectorAll('.current-response-match').forEach(h => {
        h.classList.remove('current-response-match');
      });
      matchElement.classList.add('current-response-match');
    }
  }

  private addHeaderField(name: string = '', value: string = '') {
    const headerId = Date.now().toString();
    const headerElement = document.createElement('div');
    headerElement.className = 'header-item';
    headerElement.dataset.headerId = headerId;
    
    headerElement.innerHTML = `
      <div class="header-row">
        <input 
          type="text" 
          class="header-name" 
          placeholder="Nome do header" 
          value="${this.escapeHtml(name)}"
        />
        <input 
          type="text" 
          class="header-value" 
          placeholder="Valor (use 'uuid' para gerar automaticamente)" 
          value="${this.escapeHtml(value)}"
        />
        <button type="button" class="remove-header-btn" data-header-id="${headerId}">Remover</button>
      </div>
    `;
    
    this.elements.headersList.appendChild(headerElement);
    
    // Adicionar event listener para o botão de remover
    const removeBtn = headerElement.querySelector('.remove-header-btn') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
      this.removeHeaderField(headerId);
    });
  }

  private removeHeaderField(headerId: string) {
    const headerElement = this.elements.headersList.querySelector(`[data-header-id="${headerId}"]`);
    if (headerElement) {
      headerElement.remove();
    }
  }

  private getHeadersFromForm(): Array<{ name: string; value: string }> {
    const headers: Array<{ name: string; value: string }> = [];
    
    this.elements.headersList.querySelectorAll('.header-item').forEach(item => {
      const nameInput = item.querySelector('.header-name') as HTMLInputElement;
      const valueInput = item.querySelector('.header-value') as HTMLInputElement;
      
      if (nameInput && valueInput && nameInput.value.trim()) {
        headers.push({
          name: nameInput.value.trim(),
          value: valueInput.value.trim()
        });
      }
    });
    
    return headers;
  }

  private clearHeaderFields() {
    this.elements.headersList.innerHTML = '';
  }

  private generateUUID(): string {
    // Implementação simples de UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private normalizeUrlToId(url: string): string {
    return url.trim()
      .replace(/\/$/, '')                    // Remove trailing slash
      .toLowerCase()                          // Normaliza case
      .replace(/^(https?):\/\//, '$1___')     // Transforma protocolo em https___ ou http___
      .replace(/\./g, '__')                   // Transforma . em __
      .replace(/[^\w\-\.:_]/g, '_')           // Substitui caracteres especiais, mantendo : e _
      .replace(/:/g, '___')                   // Transforma : em ___ (para portas)
      .replace(/_{2,}/g, '__')                // Normaliza múltiplos underscores
      .replace(/___+/g, '___');              // Normaliza múltiplos :___
  }

  private normalizePath(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const configManager = new ConfigManager();
  configManager.init();
});
