// TT Ball Admin Panel - Frontend JavaScript

let statsData = null;
let labelerTasks = [];
let analyzerAnalyses = [];

// =============================================================================
// Utility Functions
// =============================================================================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === 'unknown') return 'Unbekannt';
  try {
    return new Date(dateStr).toLocaleString('de-DE');
  } catch {
    return dateStr;
  }
}

function showStatus(message, type = 'info', duration = 3000) {
  const container = document.getElementById('statusContainer');
  const alert = document.createElement('div');
  
  const colors = {
    success: 'var(--success)',
    error: 'var(--danger)', 
    warning: 'var(--warning)',
    info: 'var(--accent)'
  };
  
  alert.style.cssText = `
    background: ${colors[type] || colors.info};
    color: ${type === 'warning' ? '#000' : '#fff'};
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
  `;
  alert.textContent = message;
  
  container.appendChild(alert);
  
  setTimeout(() => {
    alert.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => container.removeChild(alert), 300);
  }, duration);
}

async function apiCall(endpoint, options = {}) {
  try {
    const response = await fetch(endpoint, {
      headers: {
        'Accept': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON response:', text);
      throw new Error('Server returned non-JSON response');
    }
    
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    showStatus(`API Fehler: ${error.message}`, 'error');
    throw error;
  }
}

// =============================================================================
// Dashboard Stats
// =============================================================================

async function loadStats() {
  try {
    statsData = await apiCall('./api/stats');
    renderStats();
  } catch (error) {
    document.getElementById('statsGrid').innerHTML = 
      '<div class="error">Fehler beim Laden der Statistiken</div>';
  }
}

function renderStats() {
  const grid = document.getElementById('statsGrid');
  
  const totalSizeMB = statsData.total_size_mb;
  const labelerPercent = totalSizeMB > 0 ? (statsData.labeler_size_mb / totalSizeMB * 100) : 0;
  const analyzerPercent = totalSizeMB > 0 ? (statsData.analyzer_size_mb / totalSizeMB * 100) : 0;
  
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent);">${formatBytes(totalSizeMB * 1024 * 1024)}</div>
      <div class="stat-label">Gesamtspeicher</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:100%;"></div>
      </div>
    </div>
    
    <div class="stat-card">
      <div class="stat-value" style="color:var(--success);">${formatBytes(statsData.labeler_size_mb * 1024 * 1024)}</div>
      <div class="stat-label">Labeler Daten</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${labelerPercent}%; background:var(--success);"></div>
      </div>
      <div style="margin-top:8px; color:var(--muted); font-size:12px;">${statsData.labeler_tasks} Tasks</div>
    </div>
    
    <div class="stat-card">
      <div class="stat-value" style="color:var(--warning);">${formatBytes(statsData.analyzer_size_mb * 1024 * 1024)}</div>
      <div class="stat-label">Analyzer Daten</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${analyzerPercent}%; background:var(--warning);"></div>
      </div>
      <div style="margin-top:8px; color:var(--muted); font-size:12px;">${statsData.analyzer_analyses} Analysen</div>
    </div>
    
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent);">${statsData.labeler_tasks + statsData.analyzer_analyses}</div>
      <div class="stat-label">Gesamt Items</div>
      <div style="margin-top:16px;">
        <span class="tag success">${statsData.labeler_tasks} Tasks</span>
        <span class="tag warning">${statsData.analyzer_analyses} Analysen</span>
      </div>
    </div>
  `;
}

// =============================================================================
// Labeler Tasks Management
// =============================================================================

async function loadLabelerTasks() {
  try {
    labelerTasks = await apiCall('./api/labeler/tasks');
    renderLabelerTasks();
  } catch (error) {
    document.getElementById('labelerTableBody').innerHTML = 
      '<tr><td colspan="7" class="error">Fehler beim Laden der Tasks</td></tr>';
  }
}

function renderLabelerTasks() {
  const tbody = document.getElementById('labelerTableBody');
  
  if (labelerTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted);">Keine Tasks vorhanden</td></tr>';
    return;
  }
  
  tbody.innerHTML = labelerTasks.map(task => `
    <tr>
      <td>
        <strong>${task.task_id}</strong>
        <div style="color:var(--muted); font-size:12px;">
          ${task.meta.source || 'Unknown'} • 
          ${task.meta.fps || 'N/A'} FPS
        </div>
      </td>
      <td>${formatDate(task.created)}</td>
      <td>
        <span class="tag ${task.frames_count > 0 ? 'success' : 'muted'}">
          ${task.frames_count} Frames
        </span>
      </td>
      <td>
        <span class="tag ${task.labels_count > 0 ? 'warning' : 'muted'}">
          ${task.labels_count} Labels
        </span>
      </td>
      <td>
        ${task.has_video 
          ? `<span class="tag success">✓ ${formatBytes(task.video_size_mb * 1024 * 1024)}</span>`
          : '<span class="tag muted">Kein Video</span>'
        }
      </td>
      <td>
        <span class="size-badge">${formatBytes(task.total_size_mb * 1024 * 1024)}</span>
      </td>
      <td>
        <div class="btn-group">
          <a href="./api/labeler/task/${encodeURIComponent(task.task_id)}/download" 
             class="btn success" title="Task downloaden">📥</a>
          <button class="btn danger" onclick="deleteLabelerTask('${task.task_id}')" 
                  title="Task löschen">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function deleteLabelerTask(taskId) {
  if (!confirm(`Task "${taskId}" wirklich löschen?\\n\\nDiese Aktion kann nicht rückgängig gemacht werden.`)) {
    return;
  }
  
  try {
    await apiCall(`./api/labeler/task/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    showStatus(`Task "${taskId}" erfolgreich gelöscht`, 'success');
    await loadLabelerTasks();
    await loadStats(); // Stats aktualisieren
  } catch (error) {
    showStatus(`Fehler beim Löschen: ${error.message}`, 'error');
  }
}

async function refreshLabelerTasks() {
  showStatus('Aktualisiere Tasks...', 'info', 1000);
  await loadLabelerTasks();
}

// =============================================================================
// Analyzer Results Management
// =============================================================================

async function loadAnalyzerAnalyses() {
  try {
    analyzerAnalyses = await apiCall('./api/analyzer/analyses');
    renderAnalyzerAnalyses();
  } catch (error) {
    document.getElementById('analyzerTableBody').innerHTML = 
      '<tr><td colspan="6" class="error">Fehler beim Laden der Analysen</td></tr>';
  }
}

function renderAnalyzerAnalyses() {
  const tbody = document.getElementById('analyzerTableBody');
  
  if (analyzerAnalyses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted);">Keine Analysen vorhanden</td></tr>';
    return;
  }
  
  tbody.innerHTML = analyzerAnalyses.map(analysis => `
    <tr>
      <td>
        <strong>${analysis.analysis_id}</strong>
      </td>
      <td>${formatDate(analysis.created)}</td>
      <td>
        <div>
          ${analysis.has_heatmap ? '<span class="tag success">🔥 Heatmap</span>' : ''}
          ${analysis.has_preview ? '<span class="tag warning">🎬 Preview</span>' : ''}
          ${analysis.has_csv ? '<span class="tag success">📊 CSV</span>' : ''}
        </div>
      </td>
      <td>
        <span class="size-badge">${formatBytes(analysis.total_size_mb * 1024 * 1024)}</span>
      </td>
      <td>
        <div class="btn-group">
          ${analysis.has_heatmap 
            ? `<a href="./api/analyzer/analysis/${encodeURIComponent(analysis.analysis_id)}/download/heatmap" 
                 class="btn success" title="Heatmap">🔥</a>` 
            : ''
          }
          ${analysis.has_preview 
            ? `<button class="btn info" onclick="watchVideo('${analysis.analysis_id}')" 
                 title="Video ansehen">👁️</button>
               <a href="./api/analyzer/analysis/${encodeURIComponent(analysis.analysis_id)}/download/preview" 
                 class="btn warning" title="Preview Video downloaden">📥</a>` 
            : ''
          }
          ${analysis.has_csv 
            ? `<a href="./api/analyzer/analysis/${encodeURIComponent(analysis.analysis_id)}/download/csv" 
                 class="btn success" title="CSV Daten">📊</a>` 
            : ''
          }
          <a href="./api/analyzer/analysis/${encodeURIComponent(analysis.analysis_id)}/download-all" 
             class="btn primary" title="Alles als ZIP">📦</a>
        </div>
      </td>
      <td>
        <button class="btn danger" onclick="deleteAnalyzerAnalysis('${analysis.analysis_id}')" 
                title="Analyse löschen">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function deleteAnalyzerAnalysis(analysisId) {
  if (!confirm(`Analyse "${analysisId}" wirklich löschen?\\n\\nDiese Aktion kann nicht rückgängig gemacht werden.`)) {
    return;
  }
  
  try {
    await apiCall(`./api/analyzer/analysis/${encodeURIComponent(analysisId)}`, { method: 'DELETE' });
    showStatus(`Analyse "${analysisId}" erfolgreich gelöscht`, 'success');
    await loadAnalyzerAnalyses();
    await loadStats(); // Stats aktualisieren
  } catch (error) {
    showStatus(`Fehler beim Löschen: ${error.message}`, 'error');
  }
}

async function refreshAnalyzerAnalyses() {
  showStatus('Aktualisiere Analysen...', 'info', 1000);
  await loadAnalyzerAnalyses();
}

function watchVideo(analysisId) {
  // Video-Modal erstellen und anzeigen
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeVideoModal()"></div>
    <div class="modal-content video-modal">
      <div class="modal-header">
        <h3>🎬 Video Preview: ${analysisId}</h3>
        <button class="close-btn" onclick="closeVideoModal()">×</button>
      </div>
      <div class="modal-body">
        <video controls style="width: 100%; max-height: 70vh;">
          <source src="./api/analyzer/analysis/${encodeURIComponent(analysisId)}/watch" type="video/mp4">
          Ihr Browser unterstützt kein HTML5-Video.
        </video>
      </div>
      <div class="modal-footer">
        <button class="btn secondary" onclick="closeVideoModal()">Schließen</button>
        <a href="./api/analyzer/analysis/${encodeURIComponent(analysisId)}/download/preview" 
           class="btn primary" download>Video herunterladen</a>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
}

function closeVideoModal() {
  const modal = document.querySelector('.modal.active');
  if (modal) {
    modal.remove();
  }
}

// =============================================================================
// Cleanup Functions
// =============================================================================

function showCleanupModal() {
  document.getElementById('cleanupModal').style.display = 'flex';
}

function hideCleanupModal() {
  document.getElementById('cleanupModal').style.display = 'none';
}

async function performCleanup() {
  const days = parseInt(document.getElementById('cleanupDays').value);
  
  if (!days || days < 1) {
    showStatus('Bitte gültigen Wert für Tage eingeben', 'error');
    return;
  }
  
  if (!confirm(`Alle Daten älter als ${days} Tage löschen?\\n\\nDiese Aktion kann nicht rückgängig gemacht werden.`)) {
    return;
  }
  
  try {
    const result = await apiCall('./api/cleanup/old-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: days })
    });
    
    showStatus(`${result.deleted_count} Items erfolgreich gelöscht`, 'success');
    hideCleanupModal();
    
    // Daten neu laden
    await loadStats();
    await loadLabelerTasks();
    await loadAnalyzerAnalyses();
    
  } catch (error) {
    showStatus(`Cleanup fehlgeschlagen: ${error.message}`, 'error');
  }
}

// =============================================================================
// Event Listeners & Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async function() {
  // CSS Animation für Status-Messages hinzufügen
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(300px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(300px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
  
  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      hideCleanupModal();
    }
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
      e.preventDefault();
      location.reload();
    }
  });
  
  // Modal overlay click handler
  document.getElementById('cleanupModal').addEventListener('click', function(e) {
    if (e.target === this) {
      hideCleanupModal();
    }
  });
  
  // Initial load
  showStatus('Admin Panel wird geladen...', 'info', 2000);
  
  try {
    await Promise.all([
      loadStats(),
      loadLabelerTasks(),
      loadAnalyzerAnalyses()
    ]);
    
    showStatus('Admin Panel erfolgreich geladen', 'success');
  } catch (error) {
    showStatus('Fehler beim Laden des Admin Panels', 'error');
  }
});

// Auto-refresh every 30 seconds
setInterval(async () => {
  try {
    await loadStats();
  } catch (error) {
    console.log('Auto-refresh failed:', error);
  }
}, 30000);
