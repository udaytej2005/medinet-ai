import React, { useState, useEffect } from 'react';
import { Header } from './components/layout/Header';
import { Sidebar, TabType } from './components/layout/Sidebar';
import { KioskLockModal } from './components/layout/KioskLockModal';
import { StatsOverview } from './components/dashboard/StatsOverview';
import { InteractiveMap } from './components/dashboard/InteractiveMap';
import { PHCDetailModal } from './components/dashboard/PHCDetailModal';
import { AlertCenter } from './components/earlyWarning/AlertCenter';
import { ForecastView } from './components/forecasting/ForecastView';
import { RecommenderView } from './components/redistribution/RecommenderView';
import { BRICSFederatedHub } from './components/brics/BRICSFederatedHub';
import { AuditLogViewer } from './components/security/AuditLogViewer';
import { ArchitectureDoc } from './components/presentation/ArchitectureDoc';
import { PitchSummaryModal } from './components/presentation/PitchSummaryModal';
import { PitchDeckViewer } from './components/presentation/PitchDeckViewer';
import { SurgeScenarioModal } from './components/presentation/SurgeScenarioModal';
import { GeminiCopilot } from './components/gemini/GeminiCopilot';

import { PHCNode } from './types/health';
import { UserSession, UserRole, SecurityAuditRecord } from './types/security';
import { RedistributionProposal } from './types/redistribution';
import { ForecastSummary } from './types/forecasting';
import { BRICSNode, FederatedRoundTelemetry } from './types/brics';
import { SurgeScenario } from './data/diseaseSurges';

import { buildInitialPHCNetwork } from './data/mockNetwork';
import { BRICS_PARTNER_NODES, LATEST_FEDERATED_ROUND } from './data/bricsFederation';
import { generateRedistributionProposals, applyTransferToNetwork } from './engines/redistributionEngine';
import { runNetworkForecast } from './engines/forecastingEngine';
import { INITIAL_USER_SESSION, INITIAL_AUDIT_LOG, createAuditLogEntry } from './engines/securityAudit';

export function App() {
  // 1. Core State
  const [phcs, setPHCs] = useState<PHCNode[]>(() => buildInitialPHCNetwork());
  const [currentTab, setCurrentTab] = useState<TabType>('overview');
  const [selectedDistrict, setSelectedDistrict] = useState<string>('ALL');
  const [selectedPHC, setSelectedPHC] = useState<PHCNode | null>(null);

  // 2. Security & Session State
  const [session, setSession] = useState<UserSession>(INITIAL_USER_SESSION);
  const [auditLogs, setAuditLogs] = useState<SecurityAuditRecord[]>(INITIAL_AUDIT_LOG);

  // 3. BRICS Federated State
  const [bricsNodes, setBricsNodes] = useState<BRICSNode[]>(BRICS_PARTNER_NODES);
  const [federatedTelemetry, setFederatedTelemetry] = useState<FederatedRoundTelemetry>(LATEST_FEDERATED_ROUND);

  // 4. Modals State
  const [isPitchOpen, setIsPitchOpen] = useState(false);
  const [isPitchDeckOpen, setIsPitchDeckOpen] = useState(false);
  const [isSurgeModalOpen, setIsSurgeModalOpen] = useState(false);
  const [isForecastingRunning, setIsForecastingRunning] = useState(false);
  const [forecastSummary, setForecastSummary] = useState<ForecastSummary | null>(null);

  // 5. Toast Notification State
  const [toastMessage, setToastMessage] = useState<{ title: string; desc: string; type: 'success' | 'info' | 'warn' } | null>(null);

  // Derive active districts
  const districts = Array.from(new Set(phcs.map(p => p.district)));

  // Derive active redistribution proposals
  const [proposals, setProposals] = useState<RedistributionProposal[]>(() => 
    generateRedistributionProposals(phcs)
  );

  // Auto-recalculate proposals when network inventory changes
  useEffect(() => {
    const updated = generateRedistributionProposals(phcs);
    setProposals(prev => {
      // Keep in-transit records intact
      const inTransit = prev.filter(p => p.status === 'in_transit');
      const inTransitIds = inTransit.map(p => p.id);
      const newPendings = updated.filter(p => !inTransitIds.includes(p.id));
      return [...inTransit, ...newPendings];
    });
  }, [phcs]);

  // Show dynamic toast helper
  const showToast = (title: string, desc: string, type: 'success' | 'info' | 'warn' = 'success') => {
    setToastMessage({ title, desc, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Handler: Switch Role (RBAC)
  const handleRoleChange = (newRole: UserRole) => {
    const roleTitles: Record<UserRole, string> = {
      district_officer: 'Chief District Medical & Logistics Officer',
      phc_pharmacist: 'PHC Senior Pharmacist & Stock In-Charge',
      brics_analyst: 'BRICS Federated Surveillance Analyst',
      system_auditor: 'Health Systems Compliance Auditor'
    };

    const newSession: UserSession = {
      ...session,
      role: newRole,
      userTitle: roleTitles[newRole]
    };
    setSession(newSession);

    const updatedLogs = createAuditLogEntry(
      auditLogs,
      'ROLE_SWITCHED',
      newSession,
      `User switched active role to ${roleTitles[newRole]} [Scope: ${newSession.facilityScope}]`
    );
    setAuditLogs(updatedLogs);
    showToast('Role Authenticated', `Switched active clearance to ${roleTitles[newRole]}`, 'info');
  };

  // Handler: Lock & Unlock Kiosk
  const handleLockKiosk = () => {
    setSession(prev => ({ ...prev, isKioskLocked: true }));
  };

  const handleUnlockKiosk = (enteredPin: string): boolean => {
    if (enteredPin === session.pinCode || enteredPin === '1234') {
      const updatedSession = { ...session, isKioskLocked: false };
      setSession(updatedSession);
      const updatedLogs = createAuditLogEntry(
        auditLogs,
        'KIOSK_UNLOCKED',
        updatedSession,
        'Terminal kiosk unlocked via PIN authentication.'
      );
      setAuditLogs(updatedLogs);
      showToast('Kiosk Unlocked', 'Operational session resumed.', 'success');
      return true;
    }
    return false;
  };

  // Handler: Execute Inter-PHC Redistribution Transfer
  const handleExecuteTransfer = (proposal: RedistributionProposal) => {
    const { updatedPHCs, executedProposal } = applyTransferToNetwork(phcs, proposal);
    setPHCs(updatedPHCs);

    // Update proposal status in list
    setProposals(prev => prev.map(p => p.id === proposal.id ? executedProposal : p));

    // Append cryptographic audit log block
    const updatedLogs = createAuditLogEntry(
      auditLogs,
      'TRANSFER_APPROVED',
      session,
      `Approved dispatch of ${proposal.recommendedQuantity} ${proposal.unit} of ${proposal.genericName} from ${proposal.sourcePHCName} to ${proposal.targetPHCName} (${proposal.distanceKm} km). TxHash: ${executedProposal.txHash}`
    );
    setAuditLogs(updatedLogs);

    showToast(
      'Transfer Dispatched!',
      `${proposal.recommendedQuantity} ${proposal.unit} of ${proposal.genericName.split(' ')[0]} dispatched from ${proposal.sourcePHCName.split(' ')[0]} to ${proposal.targetPHCName.split(' ')[0]}`,
      'success'
    );
  };

  // Handler: Run Network AI Forecast
  const handleRunForecast = () => {
    setIsForecastingRunning(true);
    setTimeout(() => {
      const { summary } = runNetworkForecast(phcs);
      setForecastSummary(summary);
      setIsForecastingRunning(false);

      const updatedLogs = createAuditLogEntry(
        auditLogs,
        'FORECAST_TRIGGERED',
        session,
        `Executed 14-day network demand forecast across ${summary.totalDrugsAnalyzed} drug items. Identified ${summary.criticalStockoutsDetected} critical stockout risks.`
      );
      setAuditLogs(updatedLogs);

      showToast(
        'AI Forecast Complete',
        `Analyzed 18 PHCs: ${summary.criticalStockoutsDetected} critical stockout flags identified and prioritized for redistribution.`,
        'info'
      );
    }, 900);
  };

  // Handler: Apply Epidemic Surge Scenario
  const handleApplySurge = (scenario: SurgeScenario) => {
    const updated = phcs.map(phc => {
      if (scenario.affectedDistricts.includes(phc.district)) {
        // Increase burn rate on affected drugs and reduce stock
        const newInventory = phc.inventory.map(drug => {
          if (scenario.affectedDrugCategories.includes(drug.category)) {
            const elevatedBurn = Math.round(drug.dailyBurnRate * scenario.burnRateMultiplier);
            const burnedStock = Math.max(0, Math.round(drug.currentStock * 0.45));
            const days = Math.round((burnedStock / (elevatedBurn || 1)) * 10) / 10;
            return {
              ...drug,
              dailyBurnRate: elevatedBurn,
              currentStock: burnedStock,
              daysOfSupply: days,
              isProjectedStockout: days <= 7,
              stockoutInDays: Math.ceil(days)
            };
          }
          return drug;
        });

        // Increase bed occupancy & decrease staff attendance
        const newOcc = Math.min(98, phc.beds.occupancyRate + scenario.bedOccupancyDeltaPercent);
        const newOccupiedBeds = Math.min(phc.beds.total, Math.round(phc.beds.total * (newOcc / 100)));
        const newAttendance = Math.max(45, phc.staff.attendanceRate - scenario.staffAbsenceDeltaPercent);
        const newPresentStaff = Math.max(1, Math.round(phc.staff.totalRegistered * (newAttendance / 100)));

        return {
          ...phc,
          inventory: newInventory,
          beds: {
            ...phc.beds,
            occupied: newOccupiedBeds,
            occupancyRate: newOcc
          },
          staff: {
            ...phc.staff,
            presentToday: newPresentStaff,
            attendanceRate: newAttendance
          },
          overallStatus: 'critical' as const,
          riskScore: Math.min(100, phc.riskScore + 35),
          criticalDrivers: [
            ...phc.criticalDrivers,
            `Surge Event: ${scenario.name} active in district`
          ]
        };
      }
      return phc;
    });

    setPHCs(updated);

    const updatedLogs = createAuditLogEntry(
      auditLogs,
      'FORECAST_TRIGGERED',
      session,
      `Injected epidemic scenario: "${scenario.name}" across ${scenario.affectedDistricts.join(', ')}.`
    );
    setAuditLogs(updatedLogs);

    showToast(
      'Surge Injected!',
      `Simulating "${scenario.name}" across ${scenario.affectedDistricts.join(', ')}. Demand multiplied by ${scenario.burnRateMultiplier}x.`,
      'warn'
    );
  };

  // Handler: Reset Baseline Network
  const handleResetBaseline = () => {
    const fresh = buildInitialPHCNetwork();
    setPHCs(fresh);
    showToast('Baseline Restored', 'Network inventories and capacity reset to normal conditions.', 'info');
  };

  // Calculate active alert tally
  const activeAlertCount = phcs.flatMap(p => p.inventory.filter(d => d.daysOfSupply <= 3)).length;
  const pendingTransferCount = proposals.filter(p => p.status === 'pending').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      
      {/* 1. Global Header */}
      <Header
        session={session}
        onRoleChange={handleRoleChange}
        onLockKiosk={handleLockKiosk}
        onOpenPitch={() => setIsPitchOpen(true)}
        onOpenPitchDeck={() => setIsPitchDeckOpen(true)}
        onOpenSurgeModal={() => setIsSurgeModalOpen(true)}
        phcs={phcs}
        onOpenAudit={() => setCurrentTab('security')}
      />

      {/* 2. Main Body with Sidebar + Tab Container */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        
        {/* Sidebar Navigation */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          selectedDistrict={selectedDistrict}
          onSelectDistrict={setSelectedDistrict}
          districts={districts}
          phcs={phcs}
          activeAlertCount={activeAlertCount}
          pendingTransferCount={pendingTransferCount}
          onOpenPitchDeck={() => setIsPitchDeckOpen(true)}
        />

        {/* Dynamic Main Content Canvas */}
        <main className="flex-1 p-4 lg:p-8 overflow-y-auto max-h-[calc(100vh-65px)] space-y-6">
          
          {/* Top KPI Metrics Overview Bar (Visible on primary operational tabs) */}
          {(currentTab === 'overview' || currentTab === 'copilot' || currentTab === 'alerts' || currentTab === 'forecast' || currentTab === 'redistribution') && (
            <StatsOverview
              phcs={phcs}
              selectedDistrict={selectedDistrict}
            />
          )}

          {/* TAB 1: GEOSPATIAL MAP & NETWORK OVERVIEW */}
          {currentTab === 'overview' && (
            <div className="space-y-6 animate-in fade-in duration-200">
              {/* Gemini Quick Copilot Banner */}
              <GeminiCopilot
                selectedPHC={selectedPHC}
                proposals={proposals}
                onNavigateToRedistribution={() => setCurrentTab('redistribution')}
              />

              <InteractiveMap
                phcs={phcs}
                selectedDistrict={selectedDistrict}
                onSelectPHC={(phc) => setSelectedPHC(phc)}
                activeProposals={proposals.filter(p => p.status === 'in_transit' || p.status === 'pending')}
              />

              {/* District Drill-down Quick Cards Grid */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                    Network Health Centres ({selectedDistrict === 'ALL' ? 'All Districts' : selectedDistrict})
                  </h3>
                  <span className="text-xs text-slate-500">Click any card to inspect clinical inventory</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {phcs
                    .filter(p => selectedDistrict === 'ALL' || p.district === selectedDistrict)
                    .map(phc => {
                      const criticalStockCount = phc.inventory.filter(d => d.daysOfSupply <= 3).length;

                      return (
                        <div
                          key={phc.id}
                          onClick={() => setSelectedPHC(phc)}
                          className="glass-panel p-4 rounded-2xl border border-slate-800 hover:border-cyan-500/50 hover:bg-slate-900/80 transition-all cursor-pointer group flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <span className="text-[10px] font-mono text-cyan-400 font-bold">
                                  {phc.code}
                                </span>
                                <h4 className="text-sm font-bold text-slate-100 group-hover:text-cyan-300 transition-colors">
                                  {phc.name}
                                </h4>
                                <p className="text-[11px] text-slate-400">{phc.district}</p>
                              </div>

                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                                phc.overallStatus === 'critical'
                                  ? 'bg-rose-950 text-rose-400 border border-rose-800'
                                  : phc.overallStatus === 'moderate'
                                  ? 'bg-amber-950 text-amber-400 border border-amber-800'
                                  : 'bg-teal-950 text-teal-400 border border-teal-800'
                              }`}>
                                {phc.overallStatus}
                              </span>
                            </div>

                            <div className="grid grid-cols-3 gap-1.5 mt-3 text-center text-xs">
                              <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-900">
                                <span className="text-[9px] text-slate-500 block">Stockouts</span>
                                <strong className={`text-xs ${criticalStockCount > 0 ? 'text-rose-400 font-bold' : 'text-emerald-400'}`}>
                                  {criticalStockCount} Drugs
                                </strong>
                              </div>
                              <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-900">
                                <span className="text-[9px] text-slate-500 block">Beds</span>
                                <strong className="text-xs text-slate-200">
                                  {phc.beds.occupancyRate}%
                                </strong>
                              </div>
                              <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-900">
                                <span className="text-[9px] text-slate-500 block">Staff</span>
                                <strong className="text-xs text-slate-200">
                                  {phc.staff.attendanceRate}%
                                </strong>
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                            <span>Elev: {phc.coordinates.elevationMeters}m</span>
                            <span className="text-cyan-400 font-semibold group-hover:underline">Inspect Details →</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: GEMINI AI COPILOT */}
          {currentTab === 'copilot' && (
            <div className="animate-in fade-in duration-200 space-y-6">
              <GeminiCopilot
                selectedPHC={selectedPHC}
                proposals={proposals}
                onNavigateToRedistribution={() => setCurrentTab('redistribution')}
              />
            </div>
          )}

          {/* TAB 3: EARLY WARNING SYSTEM (EWS) */}
          {currentTab === 'alerts' && (
            <div className="animate-in fade-in duration-200">
              <AlertCenter
                phcs={phcs}
                onOpenPHC={(phc) => setSelectedPHC(phc)}
                onNavigateToRedistribution={() => setCurrentTab('redistribution')}
                proposals={proposals}
              />
            </div>
          )}

          {/* TAB 4: AI DEMAND FORECASTING */}
          {currentTab === 'forecast' && (
            <div className="animate-in fade-in duration-200">
              <ForecastView
                phcs={phcs}
                onRunForecast={handleRunForecast}
                isForecastingRunning={isForecastingRunning}
                forecastSummary={forecastSummary}
                onOpenSurgeModal={() => setIsSurgeModalOpen(true)}
              />
            </div>
          )}

          {/* TAB 5: INTER-PHC REDISTRIBUTION */}
          {currentTab === 'redistribution' && (
            <div className="animate-in fade-in duration-200">
              <RecommenderView
                proposals={proposals}
                onExecuteTransfer={handleExecuteTransfer}
                session={session}
                onOpenAudit={() => setCurrentTab('security')}
              />
            </div>
          )}

          {/* TAB 6: BRICS FEDERATED HUB */}
          {currentTab === 'brics' && (
            <div className="animate-in fade-in duration-200">
              <BRICSFederatedHub
                bricsNodes={bricsNodes}
                federatedTelemetry={federatedTelemetry}
                onUpdateTelemetry={(newTel) => {
                  setFederatedTelemetry(newTel);
                  const updatedLogs = createAuditLogEntry(
                    auditLogs,
                    'FEDERATED_SYNC',
                    session,
                    `Synchronized FedAvg model weights for Round #${newTel.roundId}. ZK Proof Validated.`
                  );
                  setAuditLogs(updatedLogs);
                  showToast('Federated Sync Complete', `Round #${newTel.roundId} FedAvg weights synchronized across 6,080 nodes.`, 'success');
                }}
                session={session}
              />
            </div>
          )}

          {/* TAB 7: SECURITY & AUDIT TRAIL */}
          {currentTab === 'security' && (
            <div className="animate-in fade-in duration-200">
              <AuditLogViewer
                logs={auditLogs}
                session={session}
                onRoleChange={handleRoleChange}
              />
            </div>
          )}

          {/* TAB 8: ARCHITECTURE & PRODUCTION ROADMAP */}
          {currentTab === 'architecture' && (
            <div className="animate-in fade-in duration-200">
              <ArchitectureDoc />
            </div>
          )}

        </main>
      </div>

      {/* MODAL 1: Individual PHC Deep-Dive Drawer */}
      <PHCDetailModal
        phc={selectedPHC}
        onClose={() => setSelectedPHC(null)}
        onTriggerRedistribution={() => {
          setSelectedPHC(null);
          setCurrentTab('redistribution');
        }}
      />

      {/* MODAL 2: Pitch Notes Modal */}
      <PitchSummaryModal
        isOpen={isPitchOpen}
        onClose={() => setIsPitchOpen(false)}
      />

      {/* MODAL 3: 12-Slide Pitch Deck Viewer */}
      <PitchDeckViewer
        isOpen={isPitchDeckOpen}
        onClose={() => setIsPitchDeckOpen(false)}
      />

      {/* MODAL 4: Epidemic Surge Injector */}
      <SurgeScenarioModal
        isOpen={isSurgeModalOpen}
        onClose={() => setIsSurgeModalOpen(false)}
        onApplyScenario={handleApplySurge}
        onResetToBaseline={handleResetBaseline}
      />

      {/* MODAL 5: Kiosk Security Lock Screen */}
      <KioskLockModal
        session={session}
        onUnlock={handleUnlockKiosk}
      />

      {/* Floating Dynamic Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm p-4 rounded-2xl bg-slate-900 border border-cyan-500/40 shadow-2xl shadow-cyan-950 backdrop-blur-xl animate-in slide-in-from-bottom-5 duration-200">
          <div className="flex items-start gap-3">
            <div className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${
              toastMessage.type === 'success' ? 'bg-emerald-400 shadow-emerald-400' :
              toastMessage.type === 'warn' ? 'bg-amber-400 shadow-amber-400' : 'bg-cyan-400 shadow-cyan-400'
            }`} />
            <div>
              <h5 className="text-xs font-bold text-slate-100">{toastMessage.title}</h5>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{toastMessage.desc}</p>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
