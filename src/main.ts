import { invoke } from "@tauri-apps/api/core";

interface Configuration {
  id: string;
  name: string;
  url: string;
  useDefaultAuth: boolean;
}

class ConfigManager {
  private configs: Configuration[] = [];
  private editingId: string | null = null;
  private readonly STORAGE_KEY = 'openapiui-configurations';

  private elements = {
    configForm: document.querySelector("#config-form") as HTMLFormElement,
    nameInput: document.querySelector("#config-name") as HTMLInputElement,
    urlInput: document.querySelector("#config-url") as HTMLInputElement,
    authCheckbox: document.querySelector("#config-auth") as HTMLInputElement,
    submitBtn: document.querySelector("#submit-btn") as HTMLButtonElement,
    cancelBtn: document.querySelector("#cancel-btn") as HTMLButtonElement,
    configsList: document.querySelector("#configs-list") as HTMLDivElement,
    configSelect: document.querySelector("#config-select") as HTMLSelectElement,
    editConfigsBtn: document.querySelector("#edit-configs-btn") as HTMLButtonElement,
    configModal: document.querySelector("#config-modal") as HTMLDivElement,
    closeModalBtn: document.querySelector("#close-modal") as HTMLButtonElement,
    welcomeScreen: document.querySelector("#welcome-screen") as HTMLDivElement,
  };

  async init() {
    this.loadConfigs();
    this.setupEventListeners();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private setupEventListeners() {
    // Form de configuração
    this.elements.configForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    this.elements.cancelBtn.addEventListener("click", () => {
      this.resetForm();
    });

    // Modal
    this.elements.editConfigsBtn.addEventListener("click", () => {
      this.showModal();
    });

    this.elements.closeModalBtn.addEventListener("click", () => {
      this.hideModal();
    });

    // Select de configurações
    this.elements.configSelect.addEventListener("change", (e) => {
      const selectedId = (e.target as HTMLSelectElement).value;
      this.handleConfigSelection(selectedId);
    });

    // Fechar modal clicando fora
    this.elements.configModal.addEventListener("click", (e) => {
      if (e.target === this.elements.configModal) {
        this.hideModal();
      }
    });
  }

  private loadConfigs() {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        this.configs = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load configurations:', error);
      this.configs = [];
    }
  }

  private saveConfigs() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.configs, null, 2));
    } catch (error) {
      console.error('Failed to save configurations:', error);
    }
  }

  private updateConfigSelect() {
    this.elements.configSelect.innerHTML = '<option value="">Selecione uma configuração</option>';
    
    this.configs.forEach(config => {
      const option = document.createElement('option');
      option.value = config.id;
      option.textContent = config.name;
      this.elements.configSelect.appendChild(option);
    });
  }

  private async handleConfigSelection(configId: string) {
    if (!configId) {
      this.elements.welcomeScreen.style.display = 'block';
      this.elements.welcomeScreen.innerHTML = `
        <h2>Bem-vindo ao OpenAPI UI</h2>
        <p>Selecione uma configuração no menu superior ou clique em "Editar Configurações" para gerenciar suas APIs.</p>
      `;
      return;
    }

    const config = this.configs.find(c => c.id === configId);
    if (config) {
      this.elements.welcomeScreen.innerHTML = `
        <h2>Configuração Selecionada</h2>
        <div class="selected-config">
          <h3>${this.escapeHtml(config.name)}</h3>
          <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
          <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'Padrão' : 'Custom'}</p>
          <div id="openapi-content" class="openapi-content">
            <p>Carregando especificação OpenAPI...</p>
          </div>
        </div>
      `;

      // Carregar o OpenAPI JSON
      await this.loadOpenApiSpec(config);
    }
  }

  private async loadOpenApiSpec(config: Configuration) {
    const openApiContent = document.getElementById('openapi-content') as HTMLDivElement;
    
    try {
      const fullUrl = `${config.url}/openapi.json`;
      console.log('Fetching OpenAPI spec from:', fullUrl);

      // Tentar usar o proxy Tauri primeiro (evita CORS)
      let openApiSpec: any;
      
      try {
        openApiSpec = await invoke('fetch_openapi_spec', {
          url: fullUrl,
          useAuth: config.useDefaultAuth
        });
        console.log('Successfully fetched via Tauri proxy');
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

        console.log('Headers:', headers);

        const response = await fetch(fullUrl, {
          method: 'GET',
          headers: headers,
          mode: 'cors',
        });

        console.log('Response status:', response.status);
        console.log('Response headers:', response.headers);

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
    const specHtml = `
      <div class="openapi-spec">
        <h4>Especificação OpenAPI</h4>
        <div class="spec-info">
          <p><strong>Título:</strong> ${this.escapeHtml(spec.info?.title || 'N/A')}</p>
          <p><strong>Versão:</strong> ${this.escapeHtml(spec.info?.version || 'N/A')}</p>
          <p><strong>Descrição:</strong> ${this.escapeHtml(spec.info?.description || 'N/A')}</p>
          <p><strong>Base URL:</strong> ${this.escapeHtml(spec.servers?.[0]?.url || 'N/A')}</p>
        </div>
        
        ${spec.paths ? `
          <div class="paths-section">
            <h5>Endpoints Disponíveis:</h5>
            <div class="paths-list">
              ${Object.entries(spec.paths).map(([path, methods]: [string, any]) => `
                <div class="path-item">
                  <h6>${this.escapeHtml(path)}</h6>
                  <div class="methods">
                    ${Object.entries(methods).map(([method, details]: [string, any]) => `
                      <div class="method ${method.toLowerCase()}">
                        <span class="method-type">${method.toUpperCase()}</span>
                        <span class="method-summary">${this.escapeHtml(details.summary || details.description || 'No description')}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
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

  private handleSubmit() {
    const name = this.elements.nameInput.value.trim();
    const url = this.elements.urlInput.value.trim();
    const useDefaultAuth = this.elements.authCheckbox.checked;

    if (!name || !url) {
      return;
    }

    if (this.editingId) {
      const configIndex = this.configs.findIndex(c => c.id === this.editingId);
      if (configIndex !== -1) {
        this.configs[configIndex] = {
          id: this.editingId,
          name,
          url,
          useDefaultAuth
        };
      }
    } else {
      const newConfig: Configuration = {
        id: Date.now().toString(),
        name,
        url,
        useDefaultAuth
      };
      this.configs.push(newConfig);
    }

    this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
    this.resetForm();
  }

  private resetForm() {
    this.elements.configForm.reset();
    this.editingId = null;
    this.elements.submitBtn.textContent = 'Adicionar Configuração';
    this.elements.cancelBtn.classList.add('hidden');
  }

  private renderConfigs() {
    if (this.configs.length === 0) {
      this.elements.configsList.innerHTML = '<p class="empty-state">Nenhuma configuração adicionada ainda.</p>';
      return;
    }

    this.elements.configsList.innerHTML = this.configs.map(config => `
      <div class="config-item" data-id="${config.id}">
        <div class="config-details">
          <h4>${this.escapeHtml(config.name)}</h4>
          <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
          <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'Padrão' : 'Custom'}</p>
        </div>
        <div class="config-actions">
          <button class="edit-btn" data-id="${config.id}">Editar</button>
          <button class="delete-btn" data-id="${config.id}">Excluir</button>
        </div>
      </div>
    `).join('');

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
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this.deleteConfig(id);
      });
    });
  }

  private editConfig(id: string) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;

    this.editingId = id;
    this.elements.nameInput.value = config.name;
    this.elements.urlInput.value = config.url;
    this.elements.authCheckbox.checked = config.useDefaultAuth;
    this.elements.submitBtn.textContent = 'Atualizar Configuração';
    this.elements.cancelBtn.classList.remove('hidden');
    
    this.elements.nameInput.focus();
  }

  private deleteConfig(id: string) {
    this.configs = this.configs.filter(c => c.id !== id);
    this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const configManager = new ConfigManager();
  configManager.init();
});
