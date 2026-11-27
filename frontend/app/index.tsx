import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useState } from "react";
import { Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import DraggableFlatList, { RenderItemParams } from "react-native-draggable-flatlist";

type Payment = { id: string; date: string; amount: number };
type Income = { id: string; date: string; product: string; amount: number; name: string; address: string; phone?: string; status?: "paid" | "pending"; tons?: number; costPerTon?: number; payments?: Payment[]; photo?: string; photos?: string[] };
type Expense = { id: string; date: string; category: string; amount: number; repairAmount: number; description: string; costPerTon: number; totalWeight: number; loads?: number; loadWeight?: number; coirOutput?: number; pithOutput?: number; trips?: number; status?: "paid" | "pending"; phone?: string; photo?: string; photos?: string[] };
type Tab = "overview" | "income" | "expenses" | "calendar" | "settings";
type Backup = { id: string; createdAt: string; incomes: Income[]; expenses: Expense[] };
type Categories = { income: string[]; expense: string[]; colors: Record<string, string> };
type Profile = { company: string; user: string };

const C = { canvas: "#F5F0E7", surface: "#FFFDF8", ink: "#1F2924", muted: "#59635C", line: "#D8D1C4", forest: "#173C2C", income: "#2F7D57", expense: "#B65A43", action: "#C76B35", highlight: "#E8D5A7", nav: "#203029", blue: "#2F6FB0" };
const STORAGE_KEY = "coir-ledger-records-v1";
const BACKUPS_KEY = "svkd-coir-backups-v1";
const CATS_KEY = "svkd-coir-categories-v1";
const PROFILE_KEY = "svkd-coir-profile-v1";
const CAT_PALETTE = ["#2F7D57", "#B65A43", "#C76B35", "#2F6FB0", "#7A5AA8", "#0E7C86", "#B4406B", "#5B7A2F", "#A67C00", "#4A5568"];
const DEFAULT_INCOME_CATS = ["Coir Pith", "Coir Bale"];
const DEFAULT_EXPENSE_CATS = ["Salaries", "Maintenance", "Husk"];
const DEFAULT_PROFILE: Profile = { company: "SVKD COIR", user: "operator" };
const FULL_BACKUP_FORMAT = "svkd-coir-full-backup";
const FULL_BACKUP_VERSION = 2;
type RestoreData = { isFull: boolean; exportedAt?: string; records: { incomes: Income[]; expenses: Expense[] }; categories?: Categories; profile?: Profile; localBackups?: Backup[] };
const normalizeBackup = (parsed: any): RestoreData | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const d = parsed.data;
  if (d && d.records && Array.isArray(d.records.incomes) && Array.isArray(d.records.expenses)) {
    const cats = d.categories && (Array.isArray(d.categories.income) || Array.isArray(d.categories.expense))
      ? { income: cleanCatList(d.categories.income, DEFAULT_INCOME_CATS), expense: cleanCatList(d.categories.expense, DEFAULT_EXPENSE_CATS), colors: cleanColors(d.categories.colors) }
      : undefined;
    const profile = d.profile && typeof d.profile === "object"
      ? { company: String(d.profile.company || DEFAULT_PROFILE.company), user: String(d.profile.user || DEFAULT_PROFILE.user) }
      : undefined;
    const localBackups = Array.isArray(d.localBackups)
      ? (d.localBackups as Record<string, unknown>[]).filter((b) => b && typeof b === "object").map((b) => ({ id: String(b.id || genId()), createdAt: String(b.createdAt || new Date().toISOString()), ...reviveRecords(b as { incomes?: unknown; expenses?: unknown }) }))
      : undefined;
    return { isFull: true, exportedAt: parsed.exportedAt, records: reviveRecords(d.records), categories: cats, profile, localBackups };
  }
  if (Array.isArray(parsed.incomes) && Array.isArray(parsed.expenses)) {
    return { isFull: false, exportedAt: parsed.exportedAt, records: reviveRecords(parsed) };
  }
  return null;
};
let BRAND = DEFAULT_PROFILE.company;
const colorFor = (name: string, colors: Record<string, string>) => colors[name] || CAT_PALETTE[Math.abs(Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0)) % CAT_PALETTE.length];
const TONS_PER_TRIP = 4; // each husk load ~4 tons -> 1 ton coir + 3 ton pith
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (v: number) => `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
const displayDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
const displayDateTime = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const waDigits = (raw?: string) => { const d = (raw || "").replace(/\D/g, ""); return d ? (d.length === 10 ? `91${d}` : d) : ""; };
const openWhatsApp = async (message: string, phone?: string) => {
  const text = encodeURIComponent(message);
  const num = waDigits(phone);
  const primary = num ? `https://wa.me/${num}?text=${text}` : (Platform.OS === "web" ? `https://wa.me/?text=${text}` : `whatsapp://send?text=${text}`);
  try { await Linking.openURL(primary); } catch { try { await Linking.openURL(`https://wa.me/?text=${text}`); } catch { /* whatsapp unavailable */ } }
};
const waStatement = (name: string, total: number, paid: number, due: number) => `Hello ${name || "there"},\n\nStatement from ${BRAND}:\nTotal purchased: ${money(total)}\nPaid: ${money(paid)}\nBalance due: ${money(due)}\n\nThank you for your business.`;
const waReminder = (name: string, due: number, days: number) => `Hello ${name || "there"},\n\nGentle reminder from ${BRAND}: ${money(due)} is pending${days ? ` (${days} days)` : ""}. Kindly arrange payment at your convenience.\n\nThank you.`;
const waSupplier = (name: string, total: number, due: number) => `Hello ${name || "there"},\n\nSupplier statement from ${BRAND}:\nTotal billed: ${money(total)}\nBalance to pay: ${money(due)}\n\nThank you.`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const paidSum = (r: Income) => (r.payments || []).reduce((sum, p) => sum + p.amount, 0);
const dueOf = (r: Income) => { const paid = paidSum(r); if (paid > 0) return Math.max(0, r.amount - paid); return r.status === "pending" ? r.amount : 0; };
const hasDue = (r: Income) => dueOf(r) > 0.009;
const expenseTotal = (r: Expense) => r.amount + (r.repairAmount || 0);
const expenseDue = (r: Expense) => (r.status === "pending" ? expenseTotal(r) : 0);
const isSameDay = (a: Date | null, b: Date) => !!a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysSince = (iso: string) => Math.floor((startOfDay(new Date()).getTime() - startOfDay(new Date(iso)).getTime()) / 86400000);
const toNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toStr = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const toIso = (v: unknown) => { const d = new Date(toStr(v)); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); };
const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const photosOf = (r: { photo?: string; photos?: string[] }) => (r.photos && r.photos.length ? r.photos : (r.photo ? [r.photo] : []));
const toStrArr = (v: unknown) => (Array.isArray(v) ? v.map(toStr).filter(Boolean) : []);
const sanitizeIncome = (r: Record<string, unknown>): Income => ({
  id: toStr(r.id) || genId(),
  date: toIso(r.date),
  product: toStr(r.product) || "Coir Pith",
  amount: toNum(r.amount),
  name: toStr(r.name),
  address: toStr(r.address),
  phone: toStr(r.phone),
  status: r.status === "pending" ? "pending" : "paid",
  tons: toNum(r.tons),
  costPerTon: toNum(r.costPerTon),
  payments: Array.isArray(r.payments) ? (r.payments as Record<string, unknown>[]).filter((p) => p && typeof p === "object").map((p) => ({ id: toStr(p?.id) || genId(), date: toIso(p?.date), amount: toNum(p?.amount) })) : [],
  photos: toStrArr(r.photos).length ? toStrArr(r.photos) : (toStr(r.photo) ? [toStr(r.photo)] : []),
});
const sanitizeExpense = (r: Record<string, unknown>): Expense => ({
  id: toStr(r.id) || genId(),
  date: toIso(r.date),
  category: toStr(r.category) || "Maintenance",
  amount: toNum(r.amount),
  repairAmount: toNum(r.repairAmount),
  description: toStr(r.description),
  costPerTon: toNum(r.costPerTon),
  totalWeight: toNum(r.totalWeight),
  loads: toNum(r.loads),
  loadWeight: toNum(r.loadWeight),
  coirOutput: toNum(r.coirOutput),
  pithOutput: toNum(r.pithOutput),
  trips: toNum(r.trips),
  status: r.status === "pending" ? "pending" : "paid",
  phone: toStr(r.phone),
  photos: toStrArr(r.photos).length ? toStrArr(r.photos) : (toStr(r.photo) ? [toStr(r.photo)] : []),
});
// Revive = coerce required fields to safe values (prevents crashes) while PRESERVING any unknown fields.
const reviveIncome = (x: unknown): Income => { const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>; return { ...r, ...sanitizeIncome(r) }; };
const reviveExpense = (x: unknown): Expense => { const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>; return { ...r, ...sanitizeExpense(r) }; };
const reviveRecords = (d: { incomes?: unknown; expenses?: unknown }) => ({
  incomes: Array.isArray(d.incomes) ? d.incomes.filter((x) => x && typeof x === "object").map(reviveIncome) : [],
  expenses: Array.isArray(d.expenses) ? d.expenses.filter((x) => x && typeof x === "object").map(reviveExpense) : [],
});
const cleanCatList = (arr: unknown, fallback: string[]) => { const out = Array.isArray(arr) ? arr.filter((c): c is string => typeof c === "string" && !!c.trim()) : []; return out.length ? out : fallback; };
const cleanColors = (o: unknown) => { const out: Record<string, string> = {}; if (o && typeof o === "object") for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === "string") out[k] = v; return out; };

export default function Index() {
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState<{ kind: "income" | "expense"; id?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState<Date | null>(null);
  const [dateTo, setDateTo] = useState<Date | null>(null);
  const [showReminders, setShowReminders] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [overdueDays, setOverdueDays] = useState(15);
  const [showBackups, setShowBackups] = useState(false);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupsReady, setBackupsReady] = useState(false);
  const [showVendors, setShowVendors] = useState(false);
  const [viewingPhotos, setViewingPhotos] = useState<{ list: string[]; index: number } | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [categories, setCategories] = useState<Categories>({ income: DEFAULT_INCOME_CATS, expense: DEFAULT_EXPENSE_CATS, colors: {} });
  const [catsReady, setCatsReady] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [profileReady, setProfileReady] = useState(false);
  const nameOptions = useMemo(() => Array.from(new Set(incomes.map((i) => i.name).filter(Boolean))), [incomes]);
  const addressOptions = useMemo(() => Array.from(new Set(incomes.map((i) => i.address).filter(Boolean))), [incomes]);
  const expenseNameOptions = useMemo(() => Array.from(new Set(expenses.map((e) => e.description).filter(Boolean))), [expenses]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) { const saved = JSON.parse(raw); const r = reviveRecords(saved); setIncomes(r.incomes); setExpenses(r.expenses); }
      setReady(true);
    });
  }, []);

  useEffect(() => { if (ready) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ incomes, expenses })); }, [incomes, expenses, ready]);

  useEffect(() => { AsyncStorage.getItem(BACKUPS_KEY).then((raw) => { if (raw) setBackups(JSON.parse(raw)); setBackupsReady(true); }); }, []);
  useEffect(() => { if (backupsReady) AsyncStorage.setItem(BACKUPS_KEY, JSON.stringify(backups)); }, [backups, backupsReady]);

  useEffect(() => {
    AsyncStorage.getItem(CATS_KEY).then((raw) => {
      if (raw) { const c = JSON.parse(raw); setCategories({ income: cleanCatList(c.income, DEFAULT_INCOME_CATS), expense: cleanCatList(c.expense, DEFAULT_EXPENSE_CATS), colors: cleanColors(c.colors) }); }
      setCatsReady(true);
    });
  }, []);
  useEffect(() => { if (catsReady) AsyncStorage.setItem(CATS_KEY, JSON.stringify(categories)); }, [categories, catsReady]);

  useEffect(() => {
    AsyncStorage.getItem(PROFILE_KEY).then((raw) => {
      if (raw) { const p = JSON.parse(raw); setProfile({ company: (p.company || DEFAULT_PROFILE.company).trim() || DEFAULT_PROFILE.company, user: (p.user || DEFAULT_PROFILE.user).trim() || DEFAULT_PROFILE.user }); }
      setProfileReady(true);
    });
  }, []);
  useEffect(() => { if (profileReady) AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }, [profile, profileReady]);

  const addCategory = (kind: "income" | "expense", name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setCategories((prev) => {
      if (prev[kind].some((c) => c.toLowerCase() === clean.toLowerCase())) return prev;
      const used = Object.values(prev.colors);
      const nextColor = CAT_PALETTE.find((p) => !used.includes(p)) || CAT_PALETTE[(prev.income.length + prev.expense.length) % CAT_PALETTE.length];
      return { ...prev, [kind]: [...prev[kind], clean], colors: { ...prev.colors, [clean]: prev.colors[clean] || nextColor } };
    });
  };
  const deleteCategory = (kind: "income" | "expense", name: string) => setCategories((prev) => ({ ...prev, [kind]: prev[kind].filter((c) => c !== name) }));
  const reorderCategories = (kind: "income" | "expense", next: string[]) => setCategories((prev) => ({ ...prev, [kind]: next }));
  const setCategoryColor = (name: string, color: string) => setCategories((prev) => ({ ...prev, colors: { ...prev.colors, [name]: color } }));

  const totalIncome = useMemo(() => incomes.reduce((sum, row) => sum + row.amount, 0), [incomes]);
  const totalExpenses = useMemo(() => expenses.reduce((sum, row) => sum + row.amount + (row.repairAmount || 0), 0), [expenses]);
  const outstanding = useMemo(() => incomes.reduce((sum, row) => sum + dueOf(row), 0), [incomes]);
  const payable = useMemo(() => expenses.reduce((sum, row) => sum + expenseDue(row), 0), [expenses]);

  const remove = (kind: "income" | "expense", id: string) => setConfirm({
    title: "Delete this record?",
    message: "It will be removed from this device only.",
    confirmLabel: "Delete",
    onConfirm: () => kind === "income" ? setIncomes((rows) => rows.filter((row) => row.id !== id)) : setExpenses((rows) => rows.filter((row) => row.id !== id)),
  });
  const updateIncome = (rec: Income) => setIncomes((rows) => rows.map((row) => row.id === rec.id ? rec : row));
  const settleIncome = (id: string) => setIncomes((rows) => rows.map((row) => {
    if (row.id !== id) return row;
    const due = dueOf(row);
    const payments = due > 0 ? [...(row.payments || []), { id: String(Date.now()), date: new Date().toISOString(), amount: due }] : (row.payments || []);
    return { ...row, payments, status: "paid" as const };
  }));
  const settleExpense = (id: string) => setExpenses((rows) => rows.map((row) => row.id === id ? { ...row, status: "paid" as const } : row));
  const createBackup = () => setBackups((prev) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString(), incomes, expenses }, ...prev].slice(0, 30));
  const deleteBackup = (id: string) => setBackups((prev) => prev.filter((b) => b.id !== id));
  const restoreBackup = (b: Backup) => { const r = reviveRecords(b); setIncomes(r.incomes); setExpenses(r.expenses); setShowBackups(false); };
  const applyRestore = async (d: RestoreData) => {
    const keys = [STORAGE_KEY, BACKUPS_KEY, CATS_KEY, PROFILE_KEY];
    const prev = await Promise.all(keys.map((k) => AsyncStorage.getItem(k)));
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(d.records));
      if (d.localBackups) await AsyncStorage.setItem(BACKUPS_KEY, JSON.stringify(d.localBackups));
      if (d.categories) await AsyncStorage.setItem(CATS_KEY, JSON.stringify(d.categories));
      if (d.profile) await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(d.profile));
      setIncomes(d.records.incomes as Income[]);
      setExpenses(d.records.expenses as Expense[]);
      if (d.localBackups) setBackups(d.localBackups);
      if (d.categories) setCategories(d.categories);
      if (d.profile) setProfile(d.profile);
      return true;
    } catch {
      try { await Promise.all(keys.map((k, i) => (prev[i] == null ? AsyncStorage.removeItem(k) : AsyncStorage.setItem(k, prev[i] as string)))); } catch { /* rollback also failed; keep state unchanged */ }
      return false;
    }
  };
  const open = (kind: "income" | "expense", id?: string) => setEditing({ kind, id });
  const payingRecord = incomes.find((row) => row.id === paying) || null;
  const title = tab === "settings" ? "Settings" : tab === "calendar" ? "Calendar" : tab === "income" ? "Income" : tab === "expenses" ? "Expenses" : "Overview";
  BRAND = profile.company;
  const greetName = profile.user ? profile.user.charAt(0).toUpperCase() + profile.user.slice(1) : "there";

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Pressable testID="open-profile-button" style={{ flex: 1, marginRight: 12 }} onPress={() => setShowProfile(true)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Image
                source={require("../assets/images/svkd-coir-logo.png")}
                    style={{ width: 52, height: 52 }}
                        resizeMode="contain"
                          />
                            <View style={{ flex: 1 }}>
                                <Text style={s.brand} numberOfLines={1}>{profile.company}</Text>
                                    <View style={s.localRow}>
                                          <View style={s.dot} />
                                                <Text style={s.local}>Stored on this device</Text>
                                                    </View>
                                                      </View>
                                                      </View>
        </Pressable>
        <Pressable testID="header-profile-icon" hitSlop={8} onPress={() => setShowProfile(true)}>
          <MaterialCommunityIcons name="account-circle-outline" size={26} color={C.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={s.overline}>{title.toUpperCase()}</Text>
        {tab === "settings" ? (
          <Settings
            incomes={incomes}
            expenses={expenses}
            onOpenCustomers={() => setShowCustomers(true)}
            onOpenBackups={() => setShowBackups(true)}
            onOpenVendors={() => setShowVendors(true)}
            onOpenCategories={() => setShowCategories(true)}
            onOpenProfile={() => setShowProfile(true)}
            onApplyRestore={applyRestore}
            requestConfirm={setConfirm}
            onClear={() => setConfirm({ title: "Clear all records?", message: "This cannot be undone.", confirmLabel: "Clear all", onConfirm: () => { setIncomes([]); setExpenses([]); } })}
          />
        ) : tab === "calendar" ? (
          <CalendarView incomes={incomes} expenses={expenses} colors={categories.colors} />
        ) : (
          <>
            <Text style={s.greeting}>Good day, {greetName}.</Text>
            <Text style={s.dateContext}>{new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</Text>
            <View style={s.summary}>
              <View style={s.netPanel}>
                <Text style={s.panelLabelDark}>NET BALANCE</Text>
                <Text testID="dashboard-net-balance" style={s.netAmount}>{money(totalIncome - totalExpenses)}</Text>
                <Text style={s.netNote}>{totalIncome - totalExpenses >= 0 ? "Available after expenses" : "Expenses are ahead of income"}</Text>
              </View>
              <View style={s.smallTotals}>
                <View><Text style={s.panelLabel}>INCOME</Text><Text testID="dashboard-total-income" style={[s.smallAmount, { color: C.income }]}>{money(totalIncome)}</Text></View>
                <View style={s.divider} />
                <View><Text style={s.panelLabel}>EXPENSES</Text><Text testID="dashboard-total-expenses" style={[s.smallAmount, { color: C.expense }]}>{money(totalExpenses)}</Text></View>
              </View>
            </View>

            {(outstanding > 0 || payable > 0) && (
              <Pressable testID="net-position-card" onPress={() => setShowReminders(true)} style={s.positionCard}>
                <View style={s.positionHead}>
                  <Text style={s.positionTitle}>MONEY POSITION</Text>
                  <View style={s.positionCta}>
                    <Text style={s.positionCtaText}>Reminders</Text>
                    <MaterialCommunityIcons name="chevron-right" size={16} color={C.action} />
                  </View>
                </View>
                <View style={s.positionRow}>
                  <View style={s.positionCol}>
                    <View style={s.positionLabelRow}><MaterialCommunityIcons name="arrow-down-left" size={13} color={C.income} /><Text style={s.positionLabel}>TO COLLECT</Text></View>
                    <Text testID="position-to-collect" style={[s.positionAmount, { color: C.income }]}>{money(outstanding)}</Text>
                  </View>
                  <View style={s.positionDivider} />
                  <View style={s.positionCol}>
                    <View style={s.positionLabelRow}><MaterialCommunityIcons name="arrow-up-right" size={13} color={C.expense} /><Text style={s.positionLabel}>TO PAY</Text></View>
                    <Text testID="position-to-pay" style={[s.positionAmount, { color: C.expense }]}>{money(payable)}</Text>
                  </View>
                </View>
                <View style={s.positionNetRow}>
                  <Text style={s.positionNetLabel}>Net position</Text>
                  <Text testID="position-net" style={[s.positionNetAmount, { color: outstanding - payable >= 0 ? C.income : C.expense }]}>{outstanding - payable >= 0 ? "+" : "−"}{money(Math.abs(outstanding - payable))}</Text>
                </View>
              </Pressable>
            )}

            <View testID="ledger-tabs" style={s.tabs}>
              {(["overview", "income", "expenses", "calendar"] as Tab[]).map((item) => (
                <Pressable key={item} testID={`ledger-tab-${item}`} onPress={() => setTab(item)} style={[s.tab, tab === item && s.selectedTab]}>
                  <Text style={[s.tabText, tab === item && s.selectedTabText]}>{item === "overview" ? "Combined" : item[0].toUpperCase() + item.slice(1)}</Text>
                </Pressable>
              ))}
            </View>

            <Filters query={query} setQuery={setQuery} dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} />

            {(tab === "overview" || tab === "income") && <Ledger kind="income" rows={incomes} categories={categories.income} colors={categories.colors} query={query} dateFrom={dateFrom} dateTo={dateTo} onAdd={() => open("income")} onEdit={(id) => open("income", id)} onDelete={remove} onOpenPayment={(id) => setPaying(id)} onViewPhotos={(list, index) => setViewingPhotos({ list, index })} />}
            {(tab === "overview" || tab === "expenses") && <Ledger kind="expense" rows={expenses} categories={categories.expense} colors={categories.colors} query={query} dateFrom={dateFrom} dateTo={dateTo} onAdd={() => open("expense")} onEdit={(id) => open("expense", id)} onDelete={remove} onViewPhotos={(list, index) => setViewingPhotos({ list, index })} />}
          </>
        )}
      </ScrollView>

      {tab !== "settings" && tab !== "calendar" && (
        <View style={s.fabRow}>
          <ActionButton testID="add-income-button" label="Bill" color={C.forest} onPress={() => open("income")} />
          <ActionButton testID="add-expense-button" label="Expense" color={C.action} onPress={() => open("expense")} />
        </View>
      )}

      <View style={s.nav}>
        {([
          { key: "overview", icon: "wallet-outline", label: "Overview" },
          { key: "income", icon: "arrow-down-left", label: "Income" },
          { key: "expenses", icon: "arrow-up-right", label: "Expenses" },
          { key: "calendar", icon: "calendar-month-outline", label: "Calendar" },
          { key: "settings", icon: "cog-outline", label: "Settings" },
        ] as { key: Tab; icon: string; label: string }[]).map((item) => (
          <Pressable key={item.key} testID={`bottom-nav-${item.key}`} style={s.navItem} onPress={() => setTab(item.key)}>
            <MaterialCommunityIcons name={item.icon as any} size={21} color={tab === item.key ? C.highlight : "#B8C1B9"} />
            <Text style={[s.navText, tab === item.key && { color: C.highlight }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {editing && (
        <RecordForm
          kind={editing.kind}
          categories={editing.kind === "income" ? categories.income : categories.expense}
          onAddCategory={(name) => addCategory(editing.kind, name)}
          suggestNames={nameOptions}
          suggestAddresses={addressOptions}
          suggestExpenseNames={expenseNameOptions}
          record={(editing.kind === "income" ? incomes : expenses).find((row) => row.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={(record) => {
            if (editing.kind === "income") setIncomes((rows) => editing.id ? rows.map((row) => row.id === editing.id ? record as Income : row) : [record as Income, ...rows]);
            else setExpenses((rows) => editing.id ? rows.map((row) => row.id === editing.id ? record as Expense : row) : [record as Expense, ...rows]);
            setEditing(null);
          }}
        />
      )}

      {showReminders && <RemindersModal incomes={incomes} expenses={expenses} overdueDays={overdueDays} setOverdueDays={setOverdueDays} onSettle={settleIncome} onSettleExpense={settleExpense} onOpenPayment={(id) => { setShowReminders(false); setPaying(id); }} onClose={() => setShowReminders(false)} />}
      {showBackups && <LocalBackupsModal backups={backups} onCreate={createBackup} onRestore={restoreBackup} onDelete={deleteBackup} requestConfirm={setConfirm} onClose={() => setShowBackups(false)} />}
      {showVendors && <VendorsModal incomes={incomes} expenses={expenses} onClose={() => setShowVendors(false)} />}
      {viewingPhotos && <PhotoViewerModal list={viewingPhotos.list} index={viewingPhotos.index} onClose={() => setViewingPhotos(null)} />}
      {showCategories && <CategoriesModal categories={categories} onAdd={addCategory} onDelete={deleteCategory} onReorder={reorderCategories} onSetColor={setCategoryColor} requestConfirm={setConfirm} onClose={() => setShowCategories(false)} />}
      {showProfile && <ProfileModal profile={profile} onSave={(p) => { setProfile(p); setShowProfile(false); }} onClose={() => setShowProfile(false)} />}
      {showCustomers && <CustomersModal incomes={incomes} onClose={() => setShowCustomers(false)} />}
      {payingRecord && <PaymentModal record={payingRecord} onChange={updateIncome} onClose={() => setPaying(null)} />}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.onConfirm(); setConfirm(null); }}
        />
      )}
    </SafeAreaView>
  );
}

function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal animationType="fade" transparent visible onRequestClose={onCancel}>
      <View style={s.confirmWrap}>
        <View testID="confirm-dialog" style={s.confirmCard}>
          <Text style={s.confirmTitle}>{title}</Text>
          <Text style={s.confirmMessage}>{message}</Text>
          <View style={s.confirmButtons}>
            <Pressable testID="confirm-cancel-button" onPress={onCancel} style={s.cancel}><Text style={s.cancelText}>Cancel</Text></Pressable>
            <Pressable testID="confirm-delete-button" onPress={onConfirm} style={s.confirmDanger}><Text style={s.saveText}>{confirmLabel}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DatePickerModal({ value, title, onSelect, onClose }: { value: Date | null; title: string; onSelect: (d: Date) => void; onClose: () => void }) {
  const [view, setView] = useState(value || new Date());
  const y = view.getFullYear();
  const m = view.getMonth();
  const firstDay = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <Modal animationType="fade" transparent visible onRequestClose={onClose}>
      <View style={s.confirmWrap}>
        <View testID="date-picker-modal" style={s.datePickerCard}>
          <Text style={s.dpHeading}>{title}</Text>
          <View style={s.dpHead}>
            <Pressable testID="dp-prev" hitSlop={8} onPress={() => setView(new Date(y, m - 1, 1))}><MaterialCommunityIcons name="chevron-left" size={24} color={C.forest} /></Pressable>
            <Text style={s.dpTitle}>{new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(view)}</Text>
            <Pressable testID="dp-next" hitSlop={8} onPress={() => setView(new Date(y, m + 1, 1))}><MaterialCommunityIcons name="chevron-right" size={24} color={C.forest} /></Pressable>
          </View>
          <View style={s.dpWeekRow}>{WEEKDAYS.map((d, i) => <Text key={i} style={s.dpWeek}>{d}</Text>)}</View>
          <View style={s.dpGrid}>
            {cells.map((c, i) => c === null ? <View key={`e${i}`} style={s.dpCell} /> : (
              <Pressable key={c} testID={`dp-day-${c}`} onPress={() => onSelect(new Date(y, m, c))} style={[s.dpCell, isSameDay(value, new Date(y, m, c)) && s.dpCellSel]}>
                <Text style={[s.dpDay, isSameDay(value, new Date(y, m, c)) && s.dpDaySel]}>{c}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.dpFoot}>
            <Pressable testID="dp-today" onPress={() => onSelect(new Date())}><Text style={s.todayLink}>Today</Text></Pressable>
            <Pressable testID="dp-close" onPress={onClose}><Text style={s.dpCloseText}>Close</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ActionButton({ label, color, onPress, testID }: { label: string; color: string; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} style={[s.fab, { backgroundColor: color }]} onPress={onPress}>
      <MaterialCommunityIcons name="plus" size={19} color="#fff" />
      <Text style={s.fabText}>{label}</Text>
    </Pressable>
  );
}

function SuggestInput({ testID, value, onChangeText, placeholder, suggestions }: { testID: string; value: string; onChangeText: (v: string) => void; placeholder: string; suggestions: string[] }) {
  const [focused, setFocused] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = focused ? suggestions.filter((sug) => sug && sug.toLowerCase().includes(q) && sug.toLowerCase() !== q).slice(0, 5) : [];
  return (
    <View>
      <TextInput testID={testID} value={value} onChangeText={onChangeText} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 180)} placeholder={placeholder} placeholderTextColor="#9DA49D" style={s.textInputBox} />
      {matches.length > 0 && (
        <View testID={`${testID}-suggestions`} style={s.suggestBox}>
          {matches.map((m) => (
            <Pressable key={m} testID={`suggest-option`} onPress={() => { onChangeText(m); setFocused(false); }} style={s.suggestItem}>
              <MaterialCommunityIcons name="history" size={15} color={C.muted} />
              <Text style={s.suggestText} numberOfLines={1}>{m}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function PhotoAttach({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [blocked, setBlocked] = useState<"" | "camera" | "gallery">("");
  const [busy, setBusy] = useState(false);

  const pick = async (source: "camera" | "gallery") => {
    if (busy) return;
    setBusy(true);
    setBlocked("");
    try {
      if (source === "camera") {
        const cur = await ImagePicker.getCameraPermissionsAsync();
        let status = cur.status;
        if (status !== "granted") {
          if (!cur.canAskAgain) { setBlocked("camera"); return; }
          const req = await ImagePicker.requestCameraPermissionsAsync();
          status = req.status;
          if (status !== "granted") { if (!req.canAskAgain) setBlocked("camera"); return; }
        }
        const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.5, base64: true, allowsEditing: true });
        if (!res.canceled && res.assets?.[0]?.base64) onChange([...value, `data:image/jpeg;base64,${res.assets[0].base64}`]);
      } else {
        const cur = await ImagePicker.getMediaLibraryPermissionsAsync();
        let status = cur.status;
        if (status !== "granted") {
          if (!cur.canAskAgain) { setBlocked("gallery"); return; }
          const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
          status = req.status;
          if (status !== "granted") { if (!req.canAskAgain) setBlocked("gallery"); return; }
        }
        const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.5, base64: true, allowsEditing: true, allowsMultipleSelection: true, selectionLimit: 6 });
        if (!res.canceled && res.assets?.length) {
          const added = res.assets.map((a) => (a.base64 ? `data:image/jpeg;base64,${a.base64}` : "")).filter(Boolean);
          if (added.length) onChange([...value, ...added]);
        }
      }
    } catch { /* cancelled or unavailable */ } finally { setBusy(false); }
  };

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <View>
      <Text style={s.inputLabel}>PHOTOS / RECEIPTS (OPTIONAL)</Text>
      {value.length > 0 && (
        <View testID="photo-preview" style={s.photoGrid}>
          {value.map((uri, i) => (
            <View key={i} style={s.photoThumbBox}>
              <Image source={{ uri }} style={s.photoThumbImg} resizeMode="cover" />
              <Pressable testID={`photo-remove-${i}`} onPress={() => removeAt(i)} style={s.photoThumbRemove}>
                <MaterialCommunityIcons name="close" size={14} color="#fff" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={s.photoButtons}>
        <Pressable testID="photo-camera-button" onPress={() => pick("camera")} disabled={busy} style={s.photoBtn}>
          <MaterialCommunityIcons name="camera-outline" size={19} color={C.forest} />
          <Text style={s.photoBtnText}>Take photo</Text>
        </Pressable>
        <Pressable testID="photo-gallery-button" onPress={() => pick("gallery")} disabled={busy} style={s.photoBtn}>
          <MaterialCommunityIcons name="image-multiple-outline" size={19} color={C.forest} />
          <Text style={s.photoBtnText}>{value.length > 0 ? "Add more" : "Choose from gallery"}</Text>
        </Pressable>
      </View>
      {blocked ? (
        <View testID="photo-permission-blocked" style={s.photoPermBox}>
          <Text style={s.photoPermText}>{blocked === "camera" ? "Camera access is blocked." : "Gallery access is blocked."} Enable it in Settings to add a photo.</Text>
          <Pressable testID="photo-open-settings" onPress={() => Linking.openSettings()} style={s.photoSettingsBtn}>
            <MaterialCommunityIcons name="cog-outline" size={15} color="#fff" />
            <Text style={s.photoSettingsText}>Open Settings</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function PhotoViewerModal({ list, index, onClose }: { list: string[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const total = list.length;
  const uri = list[Math.max(0, Math.min(i, total - 1))];
  return (
    <Modal animationType="fade" transparent visible onRequestClose={onClose}>
      <View testID="photo-viewer" style={s.photoViewerWrap}>
        <Pressable style={s.photoViewerBackdrop} onPress={onClose} />
        <Image source={{ uri }} style={s.photoViewerImage} resizeMode="contain" />
        {total > 1 && (
          <>
            <Pressable testID="photo-viewer-prev" onPress={() => setI((v) => (v - 1 + total) % total)} style={[s.photoNav, { left: 12 }]}>
              <MaterialCommunityIcons name="chevron-left" size={30} color="#fff" />
            </Pressable>
            <Pressable testID="photo-viewer-next" onPress={() => setI((v) => (v + 1) % total)} style={[s.photoNav, { right: 12 }]}>
              <MaterialCommunityIcons name="chevron-right" size={30} color="#fff" />
            </Pressable>
            <View style={s.photoCounter}><Text style={s.photoCounterText}>{(i % total + total) % total + 1} / {total}</Text></View>
          </>
        )}
        <Pressable testID="photo-viewer-close" onPress={onClose} style={s.photoViewerClose}>
          <MaterialCommunityIcons name="close" size={26} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}


function Filters({ query, setQuery, dateFrom, dateTo, setDateFrom, setDateTo }: { query: string; setQuery: (v: string) => void; dateFrom: Date | null; dateTo: Date | null; setDateFrom: (v: Date | null) => void; setDateTo: (v: Date | null) => void }) {
  const [picker, setPicker] = useState<null | "from" | "to">(null);
  return (
    <View style={s.filtersWrap}>
      <View style={s.searchRow}>
        <MaterialCommunityIcons name="magnify" size={20} color={C.muted} />
        <TextInput testID="ledger-search-input" value={query} onChangeText={setQuery} placeholder="Search name, product, category…" placeholderTextColor="#9DA49D" style={s.searchInput} returnKeyType="search" />
        {query ? <Pressable testID="search-clear-button" accessibilityLabel="Clear search" onPress={() => setQuery("")}><MaterialCommunityIcons name="close-circle" size={19} color={C.muted} /></Pressable> : null}
      </View>
      <View style={s.dateRangeRow}>
        <Pressable testID="filter-date-from" onPress={() => setPicker("from")} style={s.dateChip}>
          <MaterialCommunityIcons name="calendar-start" size={15} color={C.forest} />
          <Text style={[s.dateChipText, !dateFrom && s.dateChipPlaceholder]}>{dateFrom ? displayDate(dateFrom.toISOString()) : "From"}</Text>
        </Pressable>
        <Pressable testID="filter-date-to" onPress={() => setPicker("to")} style={s.dateChip}>
          <MaterialCommunityIcons name="calendar-end" size={15} color={C.forest} />
          <Text style={[s.dateChipText, !dateTo && s.dateChipPlaceholder]}>{dateTo ? displayDate(dateTo.toISOString()) : "To"}</Text>
        </Pressable>
        {(dateFrom || dateTo) ? <Pressable testID="filter-date-clear" onPress={() => { setDateFrom(null); setDateTo(null); }} style={s.dateClear}><Text style={s.dateClearText}>Clear</Text></Pressable> : null}
      </View>
      {picker && (
        <DatePickerModal
          value={picker === "from" ? dateFrom : dateTo}
          title={picker === "from" ? "From date" : "To date"}
          onSelect={(d) => { if (picker === "from") setDateFrom(d); else setDateTo(d); setPicker(null); }}
          onClose={() => setPicker(null)}
        />
      )}
    </View>
  );
}

function Ledger({ kind, rows, categories, colors, query, dateFrom, dateTo, onAdd, onEdit, onDelete, onOpenPayment, onViewPhotos }: { kind: "income" | "expense"; rows: (Income | Expense)[]; categories: string[]; colors: Record<string, string>; query: string; dateFrom: Date | null; dateTo: Date | null; onAdd: () => void; onEdit: (id: string) => void; onDelete: (kind: "income" | "expense", id: string) => void; onOpenPayment?: (id: string) => void; onViewPhotos?: (list: string[], index: number) => void }) {
  const isIncome = kind === "income";
  const [chip, setChip] = useState("All");
  const [pendingOnly, setPendingOnly] = useState(false);
  const catOf = (r: Income | Expense) => ("product" in r ? r.product : r.category);
  const extraCats = Array.from(new Set(rows.map(catOf))).filter((c) => c && !categories.includes(c));
  const chips = ["All", ...categories, ...extraCats];

  const filtered = rows.filter((row) => {
    if (chip !== "All") { const t = "product" in row ? row.product : row.category; if (t !== chip) return false; }
    if (pendingOnly) { const due = "product" in row ? dueOf(row) : expenseDue(row); if (due <= 0.009) return false; }
    if (query.trim()) {
      const hay = ("product" in row ? `${row.product} ${row.name} ${row.address}` : `${row.category} ${row.description}`).toLowerCase();
      if (!hay.includes(query.trim().toLowerCase())) return false;
    }
    const d = new Date(row.date);
    if (dateFrom && d < startOfDay(dateFrom)) return false;
    if (dateTo && d > endOfDay(dateTo)) return false;
    return true;
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const hasFilter = chip !== "All" || pendingOnly || !!query.trim() || !!dateFrom || !!dateTo;

  return (
    <View testID={`${kind}-table`} style={s.section}>
      <View style={s.sectionHead}>
        <View>
          <Text style={s.sectionOverline}>{isIncome ? "CASH IN" : "CASH OUT"}</Text>
          <Text style={s.sectionTitle}>{isIncome ? "Income" : "Expenses"}</Text>
        </View>
        <Pressable onPress={onAdd} style={s.addLink}>
          <MaterialCommunityIcons name="plus" size={17} color={C.forest} />
          <Text style={s.addLinkText}>Add</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterRowContent}>
        {chips.map((c) => (
          <Pressable key={c} testID={`${kind}-chip-${c.replace(/\s+/g, "-").toLowerCase()}`} onPress={() => setChip(c)} style={[s.chip, chip === c && s.chipSelected]}>
            {c !== "All" ? <View style={[s.chipDot, { backgroundColor: colorFor(c, colors) }]} /> : null}
            <Text style={[s.chipText, chip === c && s.chipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
        <Pressable testID={`${kind}-chip-pending-only`} onPress={() => setPendingOnly((v) => !v)} style={[s.chip, s.pendingChip, pendingOnly && s.pendingChipSelected]}>
          <MaterialCommunityIcons name="clock-alert-outline" size={13} color={pendingOnly ? "#fff" : C.action} />
          <Text style={[s.chipText, { color: pendingOnly ? "#fff" : C.action }]}>Pending only</Text>
        </Pressable>
      </ScrollView>

      <CategoryBreakdown kind={kind} rows={filtered} colors={colors} />

      <View style={s.tableHeader}>
        <Text style={[s.cell, s.dateCell]}>DATE</Text>
        <Text style={s.cell}>{isIncome ? "PRODUCT" : "CATEGORY"}</Text>
        <Text style={[s.cell, s.amountCell]}>AMOUNT</Text>
        <Text style={s.actionCell}> </Text>
      </View>

      {filtered.length === 0 ? (
        <View style={s.empty}>
          <MaterialCommunityIcons name={hasFilter ? "magnify" : isIncome ? "arrow-down-left" : "arrow-up-right"} size={24} color={hasFilter ? C.muted : isIncome ? C.income : C.expense} />
          <Text style={s.emptyTitle}>{hasFilter ? `No matching ${kind} records` : isIncome ? "No income recorded yet" : "No expenses recorded yet"}</Text>
          <Text style={s.emptyCopy}>{hasFilter ? "Try a different search or filter." : isIncome ? "Add your first Coir Pith or Coir Bale sale." : "Add salaries, maintenance or husk."}</Text>
        </View>
      ) : filtered.map((row) => {
        const due = isIncome ? dueOf(row as Income) : expenseDue(row as Expense);
        const partPaid = isIncome && paidSum(row as Income) > 0 && due > 0;
        const badgeLabel = due > 0 ? (partPaid ? "PART PAID" : "PENDING") : "PAID";
        return (
          <View key={row.id} style={s.row}>
            <Text style={[s.rowText, s.dateCell]}>{displayDate(row.date)}</Text>
            <View style={s.cell}>
              <Text style={s.rowText} numberOfLines={2}>{describeRow(row)}</Text>
              {isIncome ? (
                <Pressable testID="income-status-toggle" accessibilityRole="button" accessibilityLabel="Manage payments" hitSlop={10} onPress={() => onOpenPayment?.(row.id)} style={[s.badge, partPaid ? s.badgePart : due > 0 ? s.badgePending : s.badgePaid]}>
                  <MaterialCommunityIcons name={partPaid ? "circle-slice-5" : due > 0 ? "clock-outline" : "check-circle"} size={12} color={partPaid ? C.blue : due > 0 ? C.action : C.income} />
                  <Text style={[s.badgeText, { color: partPaid ? C.blue : due > 0 ? C.action : C.income }]}>{badgeLabel}</Text>
                </Pressable>
              ) : (
                <View testID="expense-status-badge" style={[s.badge, due > 0 ? s.badgePending : s.badgePaid]}>
                  <MaterialCommunityIcons name={due > 0 ? "clock-outline" : "check-circle"} size={12} color={due > 0 ? C.action : C.income} />
                  <Text style={[s.badgeText, { color: due > 0 ? C.action : C.income }]}>{due > 0 ? "PENDING" : "PAID"}</Text>
                </View>
              )}
              {photosOf(row).length > 0 ? (
                <Pressable testID="row-photo-thumb" onPress={() => onViewPhotos?.(photosOf(row), 0)} style={s.rowPhotoWrap}>
                  <Image source={{ uri: photosOf(row)[0] }} style={s.rowPhoto} resizeMode="cover" />
                  <View style={s.rowPhotoBadge}>
                    <MaterialCommunityIcons name={photosOf(row).length > 1 ? "image-multiple" : "magnify-plus-outline"} size={11} color="#fff" />
                    {photosOf(row).length > 1 ? <Text style={s.rowPhotoCount}>{photosOf(row).length}</Text> : null}
                  </View>
                </Pressable>
              ) : null}
            </View>
            <Text style={[s.rowText, s.amountCell, { color: isIncome ? C.income : C.expense }]}>{money(row.amount + ("repairAmount" in row ? row.repairAmount || 0 : 0))}</Text>
            <View style={s.rowActions}>
              <Pressable testID="record-edit-button" accessibilityLabel="Edit record" onPress={() => onEdit(row.id)}><MaterialCommunityIcons name="pencil-outline" size={19} color={C.muted} /></Pressable>
              <Pressable testID="record-delete-button" accessibilityLabel="Delete record" onPress={() => onDelete(kind, row.id)}><MaterialCommunityIcons name="trash-can-outline" size={19} color={C.expense} /></Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function CategoryBreakdown({ kind, rows, colors }: { kind: "income" | "expense"; rows: (Income | Expense)[]; colors: Record<string, string> }) {
  const isIncome = kind === "income";
  const cats = Array.from(new Set(rows.map((r) => (isIncome ? (r as Income).product : (r as Expense).category)).filter(Boolean)));
  const data = cats.map((cat) => {
    const items = rows.filter((r) => (isIncome ? (r as Income).product : (r as Expense).category) === cat);
    let received = 0, pending = 0;
    items.forEach((r) => {
      if (isIncome) { const inc = r as Income; const due = dueOf(inc); received += inc.amount - due; pending += due; }
      else { const exp = r as Expense; const due = expenseDue(exp); pending += due; received += expenseTotal(exp) - due; }
    });
    return { cat, count: items.length, received, pending, total: received + pending };
  }).filter((d) => d.count > 0);
  if (data.length === 0) return null;
  const receivedLabel = isIncome ? "RECEIVED" : "PAID";
  return (
    <View testID={`${kind}-category-breakdown`} style={s.breakdownCard}>
      <View style={s.breakdownHeadRow}>
        <Text style={s.breakdownTitle}>{isIncome ? "PRODUCT TOTALS" : "CATEGORY TOTALS"}</Text>
        <View style={s.breakdownLegend}>
          <Text style={s.breakdownLegendReceived}>● {receivedLabel}</Text>
          <Text style={s.breakdownLegendPending}>● PENDING</Text>
        </View>
      </View>
      {data.map((d) => (
        <View key={d.cat} testID={`breakdown-row-${d.cat.replace(/\s+/g, "-").toLowerCase()}`} style={s.breakdownRow}>
          <View style={s.breakdownCatCol}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={[s.chipDot, { backgroundColor: colorFor(d.cat, colors) }]} />
              <Text style={s.breakdownCat} numberOfLines={1}>{d.cat}</Text>
            </View>
            <Text style={s.breakdownCount}>{d.count} · {money(d.total)}</Text>
          </View>
          <Text style={s.breakdownReceived} testID={`breakdown-received-${d.cat.replace(/\s+/g, "-").toLowerCase()}`}>{money(d.received)}</Text>
          <Text style={s.breakdownPending} testID={`breakdown-pending-${d.cat.replace(/\s+/g, "-").toLowerCase()}`}>{money(d.pending)}</Text>
        </View>
      ))}
    </View>
  );
}

function describeRow(row: Income | Expense) {
  if ("product" in row) return `${row.product}${row.tons && row.costPerTon ? ` · ${row.tons}t @ ₹${row.costPerTon}/t` : ""}${row.name ? ` · ${row.name}` : ""}`;
  if (row.category === "Husk") return `Husk${row.description ? ` · ${row.description}` : ""}${row.trips ? ` · ${row.trips} trip${row.trips === 1 ? "" : "s"} @ ₹${row.costPerTon}/trip` : ""}`;
  return `${row.category}${row.description ? ` · ${row.description}` : ""}`;
}

function RecordForm({ kind, record, categories, onAddCategory, onClose, onSave, suggestNames, suggestAddresses, suggestExpenseNames }: { kind: "income" | "expense"; record?: Income | Expense; categories: string[]; onAddCategory: (name: string) => void; onClose: () => void; onSave: (record: Income | Expense) => void; suggestNames: string[]; suggestAddresses: string[]; suggestExpenseNames: string[] }) {
  const [date, setDate] = useState(record ? new Date(record.date) : new Date());
  const [amount, setAmount] = useState(record ? String(record.amount) : "");
  const [choice, setChoice] = useState<string>(record ? ("product" in record ? record.product : record.category) : categories[0] || (kind === "income" ? "Coir Pith" : "Salaries"));
  const [name, setName] = useState(record && "name" in record ? record.name : "");
  const [address, setAddress] = useState(record && "address" in record ? record.address : "");
  const [phone, setPhone] = useState(record && "phone" in record && record.phone ? record.phone : "");
  const [status, setStatus] = useState<"paid" | "pending">(record && "status" in record && record.status ? record.status : "pending");
  const [tons, setTons] = useState(record && "tons" in record && record.tons ? String(record.tons) : "");
  const [incomeCost, setIncomeCost] = useState(record && "product" in record && record.costPerTon ? String(record.costPerTon) : "");
  const [costPerTrip, setCostPerTrip] = useState(record && "costPerTon" in record && "category" in record ? String(record.costPerTon || "") : "");
  const [description, setDescription] = useState(record && "description" in record ? record.description : "");
  const [trips, setTrips] = useState(record && "trips" in record ? String(record.trips || record.loads || 1) : "1");
  const [manualAmount, setManualAmount] = useState(() => {
    if (kind === "expense") return choice !== "Husk";
    if (record && "tons" in record && record.tons && record.costPerTon) return false;
    return !!record;
  });
  const [showDate, setShowDate] = useState(false);
  const [error, setError] = useState("");
  const [photos, setPhotos] = useState<string[]>(record ? photosOf(record) : []);
  const [addingCat, setAddingCat] = useState(false);
  const [newCat, setNewCat] = useState("");
  const options = choice && !categories.includes(choice) ? [...categories, choice] : categories;
  const isHusk = kind === "expense" && choice === "Husk";
  const tripCount = Math.max(0, Number(trips) || 0);
  const autoKind = kind === "income" || isHusk;

  useEffect(() => {
    if (kind === "income" && !manualAmount) setAmount(((Number(tons) || 0) * (Number(incomeCost) || 0)).toFixed(2));
  }, [kind, manualAmount, tons, incomeCost]);

  useEffect(() => {
    if (isHusk && !manualAmount) setAmount(((Number(costPerTrip) || 0) * tripCount).toFixed(2));
  }, [isHusk, manualAmount, costPerTrip, tripCount]);

  const save = () => {
    const value = Number(amount.replace(/,/g, ""));
    if (!amount || !Number.isFinite(value) || value <= 0) return setError("Amount must be greater than ₹0");
    const base = { id: record?.id || String(Date.now()), date: date.toISOString(), amount: value };
    onSave(kind === "income"
      ? { ...base, product: choice, name: name.trim(), address: address.trim(), phone: phone.trim(), status, tons: Number(tons) || 0, costPerTon: Number(incomeCost) || 0, photos }
      : {
          ...base,
          category: choice,
          repairAmount: 0,
          description: description.trim(),
          phone: phone.trim(),
          loads: isHusk ? tripCount : 0,
          trips: isHusk ? tripCount : 0,
          loadWeight: isHusk ? TONS_PER_TRIP : 0,
          coirOutput: isHusk ? tripCount * (TONS_PER_TRIP * 0.25) : 0,
          pithOutput: isHusk ? tripCount * (TONS_PER_TRIP * 0.75) : 0,
          costPerTon: Number(costPerTrip) || 0,
          totalWeight: isHusk ? tripCount * TONS_PER_TRIP : 0,
          status,
          photos,
        });
  };

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={s.modalWrap}>
        <ScrollView style={s.sheet} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={s.sheetContent}>
          <View style={s.sheetHandle} />
          <View style={s.formHead}>
            <Text style={s.formTitle}>{record ? "Edit" : "Add"} {kind}</Text>
            <Pressable testID="record-close-button" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>

          <View style={s.dateLabelRow}>
            <Text style={s.inputLabel}>DATE</Text>
            <Pressable testID="record-today-button" onPress={() => setDate(new Date())}><Text style={s.todayLink}>Use today</Text></Pressable>
          </View>
          <Pressable testID="record-date-input" style={s.inputRow} onPress={() => setShowDate(true)}>
            <MaterialCommunityIcons name="calendar-month-outline" size={21} color={C.forest} />
            <Text style={s.inputValue}>{displayDate(date.toISOString())}</Text>
            <MaterialCommunityIcons name="chevron-down" size={20} color={C.muted} />
          </Pressable>
          {showDate && <DatePickerModal value={date} title="Select date" onSelect={(d) => { setDate(d); setShowDate(false); }} onClose={() => setShowDate(false)} />}

          <Text style={s.inputLabel}>{kind === "income" ? "PRODUCT" : "CATEGORY"}</Text>
          <View testID="record-type-input" style={s.options}>
            {options.map((option) => (
              <Pressable key={option} testID={`record-type-${option.replace(/\s+/g, "-").toLowerCase()}`} onPress={() => { setChoice(option); setManualAmount(kind === "income" ? manualAmount : option !== "Husk"); }} style={[s.option, choice === option && s.optionSelected]}>
                <Text style={[s.optionText, choice === option && s.optionTextSelected]}>{option}</Text>
                {choice === option && <MaterialCommunityIcons name="check" size={18} color="#fff" />}
              </Pressable>
            ))}
            <Pressable testID="record-type-add" onPress={() => setAddingCat((v) => !v)} style={[s.option, s.optionAdd]}>
              <MaterialCommunityIcons name={addingCat ? "close" : "plus"} size={16} color={C.action} />
              <Text style={[s.optionText, { color: C.action }]}>{addingCat ? "Cancel" : "New"}</Text>
            </Pressable>
          </View>
          {addingCat && (
            <View style={s.newCatRow}>
              <TextInput testID="new-category-input" value={newCat} onChangeText={setNewCat} placeholder={kind === "income" ? "New product name" : "New category name"} placeholderTextColor="#9DA49D" style={[s.textInputBox, { flex: 1 }]} autoFocus returnKeyType="done" onSubmitEditing={() => { const n = newCat.trim(); if (n) { onAddCategory(n); setChoice(n); if (kind === "expense") setManualAmount(n !== "Husk"); } setNewCat(""); setAddingCat(false); }} />
              <Pressable testID="new-category-save" onPress={() => { const n = newCat.trim(); if (n) { onAddCategory(n); setChoice(n); if (kind === "expense") setManualAmount(n !== "Husk"); } setNewCat(""); setAddingCat(false); }} style={s.newCatSave}>
                <Text style={s.newCatSaveText}>Add</Text>
              </Pressable>
            </View>
          )}

          {kind === "income" ? (
            <>
              <View style={s.twoCol}>
                <View style={s.colItem}>
                  <Text style={s.inputLabel}>TONS</Text>
                  <TextInput testID="income-tons-input" value={tons} onChangeText={(t) => { setTons(t); setManualAmount(false); }} placeholder="0" placeholderTextColor="#9DA49D" keyboardType="decimal-pad" style={s.textInputBox} />
                </View>
                <View style={s.colItem}>
                  <Text style={s.inputLabel}>COST PER TON</Text>
                  <View style={s.amountInput}>
                    <Text style={s.rupee}>₹</Text>
                    <TextInput testID="income-cost-per-ton-input" value={incomeCost} onChangeText={(t) => { setIncomeCost(t); setManualAmount(false); }} placeholder="0.00" placeholderTextColor="#9DA49D" keyboardType="decimal-pad" style={s.textInputSmall} />
                  </View>
                </View>
              </View>
              <Text style={s.inputLabel}>NAME</Text>
              <SuggestInput testID="record-name-input" value={name} onChangeText={setName} placeholder="Customer or buyer name" suggestions={suggestNames} />
              <Text style={s.inputLabel}>ADDRESS</Text>
              <SuggestInput testID="record-address-input" value={address} onChangeText={setAddress} placeholder="Customer address" suggestions={suggestAddresses} />
              <Text style={s.inputLabel}>PHONE (FOR WHATSAPP)</Text>
              <TextInput testID="record-phone-input" value={phone} onChangeText={setPhone} placeholder="e.g. 98765 43210" placeholderTextColor="#9DA49D" keyboardType="phone-pad" style={s.textInputBox} />
              <Text style={s.inputLabel}>PAYMENT STATUS</Text>
              <View style={s.options}>
                {(["pending", "paid"] as const).map((st) => (
                  <Pressable key={st} testID={`record-status-${st}`} onPress={() => setStatus(st)} style={[s.option, status === st && (st === "pending" ? s.optionSelectedWarn : s.optionSelected)]}>
                    <MaterialCommunityIcons name={st === "paid" ? "check-circle-outline" : "clock-outline"} size={16} color={status === st ? "#fff" : C.muted} />
                    <Text style={[s.optionText, status === st && s.optionTextSelected]}>{st === "paid" ? "Paid" : "Pending"}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <Text style={s.inputLabel}>{choice === "Maintenance" ? "DESCRIPTION" : "NAME"}</Text>
              <SuggestInput testID="record-description-input" value={description} onChangeText={setDescription} placeholder={choice === "Maintenance" ? "What was repaired?" : choice === "Husk" ? "Supplier / batch name" : "Employee name"} suggestions={suggestExpenseNames} />
              <Text style={s.inputLabel}>PHONE (FOR WHATSAPP)</Text>
              <TextInput testID="expense-phone-input" value={phone} onChangeText={setPhone} placeholder="e.g. 98765 43210" placeholderTextColor="#9DA49D" keyboardType="phone-pad" style={s.textInputBox} />
              {isHusk && (
                <>
                  <Text style={s.inputLabel}>NUMBER OF TRIPS</Text>
                  <TextInput testID="husk-loads-input" value={trips} onChangeText={setTrips} keyboardType="decimal-pad" style={s.textInputBox} />
                  <Text style={s.inputLabel}>COST PER TRIP</Text>
                  <View style={s.amountInput}>
                    <Text style={s.rupee}>₹</Text>
                    <TextInput testID="expense-cost-per-trip-input" value={costPerTrip} onChangeText={setCostPerTrip} placeholder="0.00" placeholderTextColor="#9DA49D" keyboardType="decimal-pad" style={s.textInput} />
                  </View>
                </>
              )}
              <Text style={s.inputLabel}>PAYMENT STATUS</Text>
              <View style={s.options}>
                {(["pending", "paid"] as const).map((st) => (
                  <Pressable key={st} testID={`expense-status-${st}`} onPress={() => setStatus(st)} style={[s.option, status === st && (st === "pending" ? s.optionSelectedWarn : s.optionSelected)]}>
                    <MaterialCommunityIcons name={st === "paid" ? "check-circle-outline" : "clock-outline"} size={16} color={status === st ? "#fff" : C.muted} />
                    <Text style={[s.optionText, status === st && s.optionTextSelected]}>{st === "paid" ? "Paid" : "Pending"}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <PhotoAttach value={photos} onChange={setPhotos} />

          <View style={s.amountModeRow}>
            <Text style={s.inputLabel}>{autoKind && !manualAmount ? "AMOUNT (AUTO)" : "AMOUNT"}</Text>
            {autoKind && (
              <Pressable testID="amount-mode-toggle" onPress={() => setManualAmount(!manualAmount)}>
                <Text style={s.manualToggle}>{manualAmount ? (kind === "income" ? "Auto from tons × cost" : "Use auto amount") : "Enter manually"}</Text>
              </Pressable>
            )}
          </View>
          <View style={[s.amountInput, error ? s.errorBorder : null]}>
            <Text style={s.rupee}>₹</Text>
            <TextInput testID="record-amount-input" value={amount} onChangeText={(text) => { setAmount(text); setManualAmount(true); setError(""); }} placeholder="0.00" placeholderTextColor="#9DA49D" keyboardType="decimal-pad" style={s.textInput} />
          </View>

          {isHusk && (
            <View testID="husk-production-summary" style={s.productionBox}>
              <Text style={s.productionTitle}>HUSK PROCESSING OUTPUT</Text>
              <Text style={s.productionText}>{trips || "0"} trip{tripCount === 1 ? "" : "s"} ≈ <Text style={s.productionStrong}>{tripCount * TONS_PER_TRIP} tons</Text> processed</Text>
              <View style={s.outputRow}>
                <Text style={s.outputText}>Coir output</Text>
                <Text style={s.outputValue}>{(tripCount * TONS_PER_TRIP * 0.25).toFixed(2)} tons</Text>
                <Text style={s.outputText}>Pith output</Text>
                <Text style={s.outputValue}>{(tripCount * TONS_PER_TRIP * 0.75).toFixed(2)} tons</Text>
              </View>
            </View>
          )}

          {error ? <Text testID="record-error" style={s.error}>{error}</Text> : null}

          <View style={s.formButtons}>
            <Pressable testID="record-cancel-button" onPress={onClose} style={s.cancel}><Text style={s.cancelText}>Cancel</Text></Pressable>
            <Pressable testID="record-save-button" onPress={save} style={s.save}><Text style={s.saveText}>Save {kind}</Text></Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CalendarView({ incomes, expenses, colors }: { incomes: Income[]; expenses: Expense[]; colors: Record<string, string> }) {
  const [mode, setMode] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(new Date());
  const [yearRef, setYearRef] = useState(new Date().getFullYear());
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const monthName = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(month);
  const inMonth = (r: { date: string }) => { const d = new Date(r.date); return d.getFullYear() === year && d.getMonth() === monthIndex; };
  const monthIncomes = incomes.filter(inMonth);
  const monthExpenses = expenses.filter(inMonth);
  const monthIncome = monthIncomes.reduce((sum, r) => sum + r.amount, 0);
  const monthExpense = monthExpenses.reduce((sum, r) => sum + r.amount + (r.repairAmount || 0), 0);

  const rows = Array.from({ length: days }, (_, i) => {
    const date = new Date(year, monthIndex, i + 1);
    const key = date.toISOString().slice(0, 10);
    const income = incomes.filter((r) => r.date.slice(0, 10) === key).reduce((sum, r) => sum + r.amount, 0);
    const expense = expenses.filter((r) => r.date.slice(0, 10) === key).reduce((sum, r) => sum + r.amount + (r.repairAmount || 0), 0);
    return { date, key, income, expense };
  }).filter((row) => row.income || row.expense);

  const dayIncomes = selected ? incomes.filter((r) => r.date.slice(0, 10) === selected) : [];
  const dayExpenses = selected ? expenses.filter((r) => r.date.slice(0, 10) === selected) : [];

  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const html = buildMonthHTML(monthName, monthIncomes, monthExpenses, monthIncome, monthExpense);
      if (Platform.OS === "web") await Print.printAsync({ html });
      else { const { uri } = await Print.printToFileAsync({ html }); if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `SVKD COIR — ${monthName}`, UTI: "com.adobe.pdf" }); }
    } catch { /* cancelled */ } finally { setExporting(false); }
  };

  return (
    <View testID="monthly-calendar">
      <View style={s.modeToggle}>
        <Pressable testID="calendar-mode-month" onPress={() => setMode("month")} style={[s.modeBtn, mode === "month" && s.modeBtnSel]}><Text style={[s.modeText, mode === "month" && s.modeTextSel]}>Month</Text></Pressable>
        <Pressable testID="calendar-mode-year" onPress={() => setMode("year")} style={[s.modeBtn, mode === "year" && s.modeBtnSel]}><Text style={[s.modeText, mode === "year" && s.modeTextSel]}>Year</Text></Pressable>
      </View>

      {mode === "year" ? (
        <YearOverview incomes={incomes} expenses={expenses} yearRef={yearRef} setYearRef={setYearRef} />
      ) : (
        <>
          <View style={s.calendarHead}>
            <Pressable testID="calendar-previous-month" onPress={() => setMonth(new Date(year, monthIndex - 1, 1))}><MaterialCommunityIcons name="chevron-left" size={25} color={C.forest} /></Pressable>
            <Text style={s.calendarTitle}>{monthName}</Text>
            <Pressable testID="calendar-next-month" onPress={() => setMonth(new Date(year, monthIndex + 1, 1))}><MaterialCommunityIcons name="chevron-right" size={25} color={C.forest} /></Pressable>
          </View>
          <View testID="calendar-month-summary" style={s.calendarSummary}>
            <View><Text style={s.panelLabel}>INCOME</Text><Text style={s.calendarIncome}>{money(monthIncome)}</Text></View>
            <View><Text style={s.panelLabel}>EXPENSES</Text><Text style={s.calendarExpense}>{money(monthExpense)}</Text></View>
            <View><Text style={s.panelLabel}>NET</Text><Text style={[s.calendarNet, { color: monthIncome - monthExpense >= 0 ? C.income : C.expense }]}>{money(monthIncome - monthExpense)}</Text></View>
          </View>

          <ProductInsights incomes={monthIncomes} scope="This month" />

          <CategoryTrends incomes={incomes} expenses={expenses} year={year} monthIndex={monthIndex} monthName={monthName} colors={colors} />

          <Pressable testID="export-month-button" onPress={exportPdf} disabled={exporting || rows.length === 0} style={[s.exportButton, (exporting || rows.length === 0) && s.exportDisabled]}>
            <MaterialCommunityIcons name="file-pdf-box" size={19} color="#fff" />
            <Text style={s.exportText}>{exporting ? "Preparing…" : `Export ${monthName} as PDF`}</Text>
          </Pressable>

          <View style={s.calendarLegend}>
            <Text style={s.legendIncome}>● Income</Text>
            <Text style={s.legendExpense}>● Expenses</Text>
            <Text style={s.legendHint}>Tap a day for details</Text>
          </View>

          {rows.length === 0 ? (
            <View style={s.empty}>
              <MaterialCommunityIcons name="calendar-blank-outline" size={30} color={C.action} />
              <Text style={s.emptyTitle}>No activity this month</Text>
              <Text style={s.emptyCopy}>Income and expenses will appear here by day.</Text>
            </View>
          ) : rows.map((row) => (
            <Pressable key={row.key} testID="calendar-day-row" onPress={() => setSelected(row.key)} style={s.dayRow}>
              <View style={s.dayDate}><Text style={s.dayNumber}>{row.date.getDate()}</Text><Text style={s.dayName}>{new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(row.date)}</Text></View>
              <View style={s.dayValues}>
                {row.income ? <Text style={s.dayIncome}>+ {money(row.income)}</Text> : <Text style={s.dayMuted}>—</Text>}
                {row.expense ? <Text style={s.dayExpense}>− {money(row.expense)}</Text> : <Text style={s.dayMuted}>—</Text>}
              </View>
              <Text style={[s.dayNet, { color: row.income - row.expense >= 0 ? C.income : C.expense }]}>{money(row.income - row.expense)}</Text>
              <MaterialCommunityIcons name="chevron-right" size={18} color={C.line} />
            </Pressable>
          ))}
        </>
      )}

      {selected && <DayDetailModal dateKey={selected} incomes={dayIncomes} expenses={dayExpenses} onClose={() => setSelected(null)} />}
    </View>
  );
}

function YearOverview({ incomes, expenses, yearRef, setYearRef }: { incomes: Income[]; expenses: Expense[]; yearRef: number; setYearRef: (y: number) => void }) {
  const data = MONTHS.map((label, m) => {
    const inc = incomes.filter((r) => { const d = new Date(r.date); return d.getFullYear() === yearRef && d.getMonth() === m; }).reduce((sum, r) => sum + r.amount, 0);
    const exp = expenses.filter((r) => { const d = new Date(r.date); return d.getFullYear() === yearRef && d.getMonth() === m; }).reduce((sum, r) => sum + r.amount + (r.repairAmount || 0), 0);
    return { label, inc, exp, net: inc - exp };
  });
  const max = Math.max(1, ...data.map((d) => Math.max(d.inc, d.exp)));
  const yearIncomes = incomes.filter((r) => new Date(r.date).getFullYear() === yearRef);
  const active = data.filter((d) => d.inc || d.exp);
  const yearIncome = data.reduce((s, d) => s + d.inc, 0);
  const yearExpense = data.reduce((s, d) => s + d.exp, 0);
  const best = active.length ? active.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = active.length ? active.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  const CH = 150;

  return (
    <View testID="yearly-overview">
      <View style={s.calendarHead}>
        <Pressable testID="year-prev" onPress={() => setYearRef(yearRef - 1)}><MaterialCommunityIcons name="chevron-left" size={25} color={C.forest} /></Pressable>
        <Text style={s.calendarTitle}>{yearRef}</Text>
        <Pressable testID="year-next" onPress={() => setYearRef(yearRef + 1)}><MaterialCommunityIcons name="chevron-right" size={25} color={C.forest} /></Pressable>
      </View>
      <View style={s.calendarSummary}>
        <View><Text style={s.panelLabel}>INCOME</Text><Text style={s.calendarIncome}>{money(yearIncome)}</Text></View>
        <View><Text style={s.panelLabel}>EXPENSES</Text><Text style={s.calendarExpense}>{money(yearExpense)}</Text></View>
        <View><Text style={s.panelLabel}>NET</Text><Text style={[s.calendarNet, { color: yearIncome - yearExpense >= 0 ? C.income : C.expense }]}>{money(yearIncome - yearExpense)}</Text></View>
      </View>

      {active.length === 0 ? (
        <View style={s.empty}>
          <MaterialCommunityIcons name="chart-bar" size={30} color={C.action} />
          <Text style={s.emptyTitle}>No activity in {yearRef}</Text>
          <Text style={s.emptyCopy}>Add records to see the monthly chart.</Text>
        </View>
      ) : (
        <>
          <View style={s.calendarLegend}>
            <Text style={s.legendIncome}>● Income</Text>
            <Text style={s.legendExpense}>● Expenses</Text>
          </View>
          <View style={s.chartCard}>
            <View style={[s.chartBars, { height: CH }]}>
              {data.map((d) => (
                <View key={d.label} style={s.chartCol}>
                  <View style={s.chartPair}>
                    <View style={[s.barIncome, { height: Math.max(d.inc ? 3 : 0, Math.round((d.inc / max) * CH)) }]} />
                    <View style={[s.barExpense, { height: Math.max(d.exp ? 3 : 0, Math.round((d.exp / max) * CH)) }]} />
                  </View>
                  <Text style={s.chartMonth}>{d.label[0]}</Text>
                </View>
              ))}
            </View>
          </View>
          <View style={s.bestWorst}>
            {best && <View style={s.bwItem}><MaterialCommunityIcons name="trophy-outline" size={16} color={C.income} /><Text style={s.bwText}>Best: <Text style={s.bwStrong}>{best.label}</Text> ({money(best.net)})</Text></View>}
            {worst && <View style={s.bwItem}><MaterialCommunityIcons name="trending-down" size={16} color={C.expense} /><Text style={s.bwText}>Lowest: <Text style={s.bwStrong}>{worst.label}</Text> ({money(worst.net)})</Text></View>}
          </View>
          <ProductInsights incomes={yearIncomes} scope={String(yearRef)} />
        </>
      )}
    </View>
  );
}

function DayDetailModal({ dateKey, incomes, expenses, onClose }: { dateKey: string; incomes: Income[]; expenses: Expense[]; onClose: () => void }) {
  const dayIncome = incomes.reduce((sum, r) => sum + r.amount, 0);
  const dayExpense = expenses.reduce((sum, r) => sum + r.amount + (r.repairAmount || 0), 0);
  const [exporting, setExporting] = useState(false);
  const exportDay = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const label = displayDate(dateKey);
      const html = buildMonthHTML(label, incomes, expenses, dayIncome, dayExpense);
      if (Platform.OS === "web") await Print.printAsync({ html });
      else { const { uri } = await Print.printToFileAsync({ html }); if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `${BRAND} — ${label}`, UTI: "com.adobe.pdf" }); }
    } catch { /* cancelled */ } finally { setExporting(false); }
  };
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>DAY DETAILS</Text>
              <Text style={s.formTitle}>{displayDate(dateKey)}</Text>
            </View>
            <Pressable testID="day-detail-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <ScrollView testID="day-detail-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
            <View style={s.detailSummary}>
              <View><Text style={s.panelLabel}>INCOME</Text><Text style={[s.smallAmount, { color: C.income }]}>{money(dayIncome)}</Text></View>
              <View><Text style={s.panelLabel}>EXPENSES</Text><Text style={[s.smallAmount, { color: C.expense }]}>{money(dayExpense)}</Text></View>
              <View><Text style={s.panelLabel}>NET</Text><Text style={[s.smallAmount, { color: dayIncome - dayExpense >= 0 ? C.income : C.expense }]}>{money(dayIncome - dayExpense)}</Text></View>
            </View>
            <Pressable testID="day-export-button" onPress={exportDay} disabled={exporting || (incomes.length === 0 && expenses.length === 0)} style={[s.statementBtn, (exporting || (incomes.length === 0 && expenses.length === 0)) && s.exportDisabled]}>
              <MaterialCommunityIcons name="file-pdf-box" size={16} color={C.forest} />
              <Text style={s.statementBtnText}>{exporting ? "Preparing…" : "Export day (PDF + photos)"}</Text>
            </Pressable>
            <Text style={s.detailSectionLabel}>INCOME</Text>
            {incomes.length === 0 ? <Text style={s.detailEmpty}>No income on this day.</Text> : incomes.map((r) => (
              <View key={r.id} testID="day-detail-income-row" style={s.detailRow}>
                <View style={s.detailRowMain}>
                  <Text style={s.detailRowTitle}>{describeRow(r)}</Text>
                  <Text style={[s.detailStatus, { color: dueOf(r) > 0 ? C.action : C.income }]}>{dueOf(r) > 0 ? `Due ${money(dueOf(r))}` : "Paid"}</Text>
                </View>
                <Text style={[s.detailAmount, { color: C.income }]}>+ {money(r.amount)}</Text>
              </View>
            ))}
            <Text style={s.detailSectionLabel}>EXPENSES</Text>
            {expenses.length === 0 ? <Text style={s.detailEmpty}>No expenses on this day.</Text> : expenses.map((r) => (
              <View key={r.id} testID="day-detail-expense-row" style={s.detailRow}>
                <View style={s.detailRowMain}><Text style={s.detailRowTitle}>{describeRow(r)}</Text></View>
                <Text style={[s.detailAmount, { color: C.expense }]}>− {money(r.amount + (r.repairAmount || 0))}</Text>
              </View>
            ))}
            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function RemindersModal({ incomes, expenses, overdueDays, setOverdueDays, onSettle, onSettleExpense, onOpenPayment, onClose }: { incomes: Income[]; expenses: Expense[]; overdueDays: number; setOverdueDays: (n: number) => void; onSettle: (id: string) => void; onSettleExpense: (id: string) => void; onOpenPayment: (id: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"receivables" | "payables">("receivables");
  const isRec = mode === "receivables";
  const overdue = incomes.filter(hasDue).map((r) => ({ r, days: daysSince(r.date) })).filter((x) => x.days >= overdueDays).sort((a, b) => b.days - a.days);
  const payDue = expenses.filter((e) => expenseDue(e) > 0.009).map((r) => ({ r, days: daysSince(r.date) })).filter((x) => x.days >= overdueDays).sort((a, b) => b.days - a.days);
  const totalOverdue = overdue.reduce((sum, x) => sum + dueOf(x.r), 0);
  const totalPay = payDue.reduce((sum, x) => sum + expenseDue(x.r), 0);
  const activeTotal = isRec ? totalOverdue : totalPay;
  const activeCount = isRec ? overdue.length : payDue.length;
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>PAYMENT REMINDERS</Text>
              <Text style={s.formTitle}>{isRec ? "To collect" : "To pay"}</Text>
            </View>
            <Pressable testID="reminders-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <View style={[s.modeToggle, { marginHorizontal: 20, marginBottom: 4 }]}>
            <Pressable testID="reminders-tab-receivables" onPress={() => setMode("receivables")} style={[s.modeBtn, isRec && s.modeBtnSel]}><Text style={[s.modeText, isRec && s.modeTextSel]}>Customers owe you</Text></Pressable>
            <Pressable testID="reminders-tab-payables" onPress={() => setMode("payables")} style={[s.modeBtn, !isRec && s.modeBtnSel]}><Text style={[s.modeText, !isRec && s.modeTextSel]}>You owe suppliers</Text></Pressable>
          </View>
          <ScrollView testID="reminders-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
            <Text style={s.detailSectionLabel}>OLDER THAN</Text>
            <View style={s.reminderChips}>
              {[0, 7, 15, 30, 60].map((n) => (
                <Pressable key={n} testID={`reminder-days-${n}`} onPress={() => setOverdueDays(n)} style={[s.chip, overdueDays === n && s.chipSelected]}>
                  <Text style={[s.chipText, overdueDays === n && s.chipTextSelected]}>{n === 0 ? "All" : `${n} days`}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.reminderTotal}>
              <Text style={s.reminderTotalLabel}>{activeCount} pending{overdueDays ? ` · beyond ${overdueDays} days` : ""}</Text>
              <Text style={s.reminderTotalAmt}>{money(activeTotal)}</Text>
            </View>
            {isRec ? (
              overdue.length === 0 ? (
                <View style={s.empty}>
                  <MaterialCommunityIcons name="check-circle-outline" size={30} color={C.income} />
                  <Text style={s.emptyTitle}>Nothing to collect</Text>
                  <Text style={s.emptyCopy}>{overdueDays ? `No customer dues older than ${overdueDays} days.` : "No pending customer dues right now."}</Text>
                </View>
              ) : overdue.map(({ r, days }) => (
                <View key={r.id} testID="reminder-row" style={s.detailRow}>
                  <Pressable style={s.detailRowMain} testID="reminder-open-payment" onPress={() => onOpenPayment(r.id)}>
                    <Text style={s.detailRowTitle}>{r.name || "Unnamed customer"}</Text>
                    <Text style={s.reminderMeta}>{r.product} · {days} days overdue · due {money(dueOf(r))}</Text>
                  </Pressable>
                  <View style={s.reminderRight}>
                    <Pressable testID="reminder-whatsapp" hitSlop={8} onPress={() => openWhatsApp(waReminder(r.name, dueOf(r), days), r.phone)} style={s.waSmall}><MaterialCommunityIcons name="whatsapp" size={13} color="#fff" /><Text style={s.waSmallText}>Remind</Text></Pressable>
                    <Pressable testID="reminder-mark-paid" hitSlop={8} onPress={() => onSettle(r.id)} style={s.markPaid}><Text style={s.markPaidText}>Mark paid</Text></Pressable>
                  </View>
                </View>
              ))
            ) : (
              payDue.length === 0 ? (
                <View style={s.empty}>
                  <MaterialCommunityIcons name="check-circle-outline" size={30} color={C.income} />
                  <Text style={s.emptyTitle}>Nothing to pay</Text>
                  <Text style={s.emptyCopy}>{overdueDays ? `No supplier dues older than ${overdueDays} days.` : "No pending supplier dues right now."}</Text>
                </View>
              ) : payDue.map(({ r, days }) => (
                <View key={r.id} testID="payable-row" style={s.detailRow}>
                  <View style={s.detailRowMain}>
                    <Text style={s.detailRowTitle}>{r.description || r.category}</Text>
                    <Text style={s.reminderMeta}>{r.category} · {days} days · owe {money(expenseDue(r))}</Text>
                  </View>
                  <View style={s.reminderRight}>
                    <Pressable testID="payable-mark-paid" hitSlop={8} onPress={() => onSettleExpense(r.id)} style={s.markPaid}><Text style={s.markPaidText}>Mark paid</Text></Pressable>
                  </View>
                </View>
              ))
            )}
            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function CustomersModal({ incomes, onClose }: { incomes: Income[]; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const map = new Map<string, { name: string; phone: string; total: number; pending: number; count: number; records: Income[] }>();
  incomes.forEach((r) => {
    const key = (r.name || "").trim() || "Unnamed customer";
    const cur = map.get(key) || { name: key, phone: "", total: 0, pending: 0, count: 0, records: [] };
    cur.total += r.amount; cur.pending += dueOf(r); cur.count += 1; cur.records.push(r);
    if (!cur.phone && r.phone) cur.phone = r.phone;
    map.set(key, cur);
  });
  const customers = [...map.values()].sort((a, b) => b.pending - a.pending || b.total - a.total);

  const sendStatement = async (name: string, records: Income[], total: number, pending: number) => {
    if (busy) return;
    setBusy(name);
    try {
      const html = buildCustomerHTML(name, records, total, pending);
      if (Platform.OS === "web") await Print.printAsync({ html });
      else { const { uri } = await Print.printToFileAsync({ html }); if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${name}`, UTI: "com.adobe.pdf" }); }
    } catch { /* cancelled */ } finally { setBusy(null); }
  };

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>CUSTOMER STATEMENTS</Text>
              <Text style={s.formTitle}>Customers</Text>
            </View>
            <Pressable testID="customers-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <ScrollView testID="customers-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
            {customers.length === 0 ? (
              <View style={s.empty}>
                <MaterialCommunityIcons name="account-group-outline" size={30} color={C.action} />
                <Text style={s.emptyTitle}>No customers yet</Text>
                <Text style={s.emptyCopy}>Add income with a customer name to build statements.</Text>
              </View>
            ) : customers.map((c) => (
              <View key={c.name} testID="customer-row" style={s.customerRow}>
                <View style={s.customerTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.customerName}>{c.name}</Text>
                    <Text style={s.customerMeta}>{c.count} order{c.count === 1 ? "" : "s"} · Total {money(c.total)}</Text>
                  </View>
                  {c.pending > 0 && <View style={[s.badge, s.badgePending]}><Text style={[s.badgeText, { color: C.action }]}>{money(c.pending)} DUE</Text></View>}
                </View>
                <Pressable testID="customer-statement-button" onPress={() => sendStatement(c.name, c.records, c.total, c.pending)} disabled={!!busy} style={[s.statementBtn, !!busy && s.exportDisabled]}>
                  <MaterialCommunityIcons name="file-pdf-box" size={16} color={C.forest} />
                  <Text style={s.statementBtnText}>{busy === c.name ? "Preparing…" : "Send statement (PDF)"}</Text>
                </Pressable>
                <Pressable testID="customer-whatsapp-button" onPress={() => openWhatsApp(waStatement(c.name, c.total, c.total - c.pending, c.pending), c.phone)} style={s.waBtn}>
                  <MaterialCommunityIcons name="whatsapp" size={16} color="#fff" />
                  <Text style={s.waBtnText}>Send on WhatsApp</Text>
                </Pressable>
              </View>
            ))}
            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Settings({ incomes, expenses, onClear, onOpenCustomers, onOpenBackups, onOpenVendors, onOpenCategories, onOpenProfile, onApplyRestore, requestConfirm }: { incomes: Income[]; expenses: Expense[]; onClear: () => void; onOpenCustomers: () => void; onOpenBackups: () => void; onOpenVendors: () => void; onOpenCategories: () => void; onOpenProfile: () => void; onApplyRestore: (d: RestoreData) => Promise<boolean>; requestConfirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void }) {
  const [notice, setNotice] = useState("");
  const [noticeErr, setNoticeErr] = useState(false);
  const say = (msg: string, err = false) => { setNotice(msg); setNoticeErr(err); };
  const [busy, setBusy] = useState(false);

  const exportFull = async () => {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const [rec, bks, cats, prof] = await Promise.all([STORAGE_KEY, BACKUPS_KEY, CATS_KEY, PROFILE_KEY].map((k) => AsyncStorage.getItem(k)));
      const records = rec ? JSON.parse(rec) : { incomes: [], expenses: [] };
      const payload = {
        app: "SVKD COIR",
        format: FULL_BACKUP_FORMAT,
        version: FULL_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
          records,
          localBackups: bks ? JSON.parse(bks) : [],
          categories: cats ? JSON.parse(cats) : { income: DEFAULT_INCOME_CATS, expense: DEFAULT_EXPENSE_CATS, colors: {} },
          profile: prof ? JSON.parse(prof) : DEFAULT_PROFILE,
        },
      };
      const json = JSON.stringify(payload, null, 2);
      const fname = `SVKD-COIR-Full-Backup-${new Date().toISOString().slice(0, 10)}.json`;
      if (Platform.OS === "web") {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } else {
        const uri = (FileSystem.cacheDirectory || FileSystem.documentDirectory || "") + fname;
        await FileSystem.writeAsStringAsync(uri, json);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/json", dialogTitle: "SVKD COIR Full Backup", UTI: "public.json" });
      }
      const inc = (records.incomes || []).length, exp = (records.expenses || []).length;
      say(`Full backup ready (${inc} income, ${exp} expense). Photos saved as images export fine; any device-only file links may not open on another phone.`);
    } catch { say("Could not create the backup file.", true); } finally { setBusy(false); }
  };

  const doRestore = async () => {
    say("");
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ["application/json", "text/plain", "*/*"], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      const content = Platform.OS === "web" ? await (await fetch(asset.uri)).text() : await FileSystem.readAsStringAsync(asset.uri);
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { say("That file is not valid JSON.", true); return; }
      const norm = normalizeBackup(parsed);
      if (!norm) { say("That file is not a SVKD COIR backup.", true); return; }
      const inc = norm.records.incomes.length, exp = norm.records.expenses.length, bk = norm.localBackups ? norm.localBackups.length : 0;
      const when = norm.exportedAt ? ` from ${displayDate(norm.exportedAt)}` : "";
      const extra = norm.isFull ? ` It also restores categories, colours, profile and ${bk} saved snapshot${bk === 1 ? "" : "s"}.` : " Your categories, colours and profile will be kept.";
      requestConfirm({
        title: "Restore this backup?",
        message: `Backup${when}: ${inc} income, ${exp} expense record${exp === 1 ? "" : "s"}.${extra} This replaces your current records.`,
        confirmLabel: "Restore",
        onConfirm: async () => { const ok = await onApplyRestore(norm); say(ok ? "Backup restored successfully." : "Restore failed — your previous data was kept.", !ok); },
      });
    } catch { say("Could not read that file.", true); }
  };

  return (
    <View style={s.settings}>
      <Pressable testID="open-profile-row" style={s.settingRow} onPress={onOpenProfile}>
        <MaterialCommunityIcons name="store-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Business profile</Text><Text style={s.settingSub}>Edit your company name &amp; your name.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="open-customers-button" style={s.settingRow} onPress={onOpenCustomers}>
        <MaterialCommunityIcons name="account-group-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Customer statements</Text><Text style={s.settingSub}>See orders and dues per customer, and send a PDF statement.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="open-vendors-button" style={s.settingRow} onPress={onOpenVendors}>
        <MaterialCommunityIcons name="swap-horizontal" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Customers &amp; suppliers</Text><Text style={s.settingSub}>Separate lists for people you sell to and suppliers you pay. Tap to view history &amp; export a PDF.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="open-categories-button" style={s.settingRow} onPress={onOpenCategories}>
        <MaterialCommunityIcons name="tag-multiple-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Manage categories</Text><Text style={s.settingSub}>Add your own income products &amp; expense categories.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="export-full-backup-button" style={s.settingRow} onPress={exportFull} disabled={busy}>
        <MaterialCommunityIcons name="database-export-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>{busy ? "Preparing…" : "Export Full Backup"}</Text><Text style={s.settingSub}>Save everything — records, photos, categories, colours &amp; profile — as one JSON file.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="open-backups-button" style={s.settingRow} onPress={onOpenBackups}>
        <MaterialCommunityIcons name="content-save-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Local backups</Text><Text style={s.settingSub}>Save and restore snapshots kept on this device.</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      <Pressable testID="restore-button" style={s.settingRow} onPress={doRestore}>
        <MaterialCommunityIcons name="cloud-download-outline" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Restore from backup</Text><Text style={s.settingSub}>Load a full or legacy backup file (replaces current data).</Text></View>
        <MaterialCommunityIcons name="chevron-right" size={20} color={C.muted} />
      </Pressable>
      {notice ? <Text testID="settings-notice" style={s.settingsNotice}>{notice}</Text> : null}
      <View style={s.settingRow}>
        <MaterialCommunityIcons name="cellphone-lock" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Private by default</Text><Text style={s.settingSub}>Your records are stored only on this device.</Text></View>
      </View>
      <View style={s.settingRow}>
        <MaterialCommunityIcons name="cash" size={22} color={C.forest} />
        <View style={s.settingCopy}><Text style={s.settingTitle}>Currency</Text><Text style={s.settingSub}>Indian Rupee (₹ INR)</Text></View>
      </View>
      <Pressable testID="clear-all-records-button" style={s.clearButton} onPress={onClear}>
        <MaterialCommunityIcons name="delete-sweep-outline" size={20} color={C.expense} />
        <Text style={s.clearText}>Clear all records</Text>
      </Pressable>
    </View>
  );
}

function PaymentModal({ record, onChange, onClose }: { record: Income; onChange: (r: Income) => void; onClose: () => void }) {
  const payments = record.payments || [];
  const paid = paidSum(record);
  const due = Math.max(0, record.amount - paid);
  const [amt, setAmt] = useState(due ? String(Math.round(due)) : "");
  const [date, setDate] = useState(new Date());
  const [showDate, setShowDate] = useState(false);

  const commit = (np: Payment[]) => {
    const newPaid = np.reduce((sum, p) => sum + p.amount, 0);
    onChange({ ...record, payments: np, status: newPaid >= record.amount - 0.009 ? "paid" : "pending" });
  };
  const addPayment = () => {
    const v = Number(amt.replace(/,/g, ""));
    if (!v || v <= 0) return;
    commit([...payments, { id: String(Date.now()), date: date.toISOString(), amount: v }]);
    setAmt("");
  };
  const removePayment = (id: string) => commit(payments.filter((p) => p.id !== id));
  const settle = () => { if (due > 0) commit([...payments, { id: String(Date.now()), date: new Date().toISOString(), amount: due }]); };

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>PAYMENTS</Text>
              <Text style={s.formTitle}>{record.name || "Customer"}</Text>
            </View>
            <Pressable testID="payment-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <ScrollView testID="payment-modal" style={s.detailScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={s.detailSummary}>
              <View><Text style={s.panelLabel}>TOTAL</Text><Text style={[s.smallAmount, { color: C.ink }]}>{money(record.amount)}</Text></View>
              <View><Text style={s.panelLabel}>PAID</Text><Text style={[s.smallAmount, { color: C.income }]}>{money(paid)}</Text></View>
              <View><Text style={s.panelLabel}>DUE</Text><Text testID="payment-due" style={[s.smallAmount, { color: due > 0 ? C.action : C.income }]}>{money(due)}</Text></View>
            </View>

            {due > 0 && (
              <>
                <Text style={s.detailSectionLabel}>RECORD A PART-PAYMENT</Text>
                <Pressable testID="payment-date-input" style={s.inputRow} onPress={() => setShowDate(true)}>
                  <MaterialCommunityIcons name="calendar-month-outline" size={20} color={C.forest} />
                  <Text style={s.inputValue}>{displayDate(date.toISOString())}</Text>
                  <MaterialCommunityIcons name="chevron-down" size={20} color={C.muted} />
                </Pressable>
                <View style={s.payRow}>
                  <View style={[s.amountInput, { flex: 1 }]}>
                    <Text style={s.rupee}>₹</Text>
                    <TextInput testID="payment-amount-input" value={amt} onChangeText={setAmt} placeholder="0.00" placeholderTextColor="#9DA49D" keyboardType="decimal-pad" style={s.textInput} />
                  </View>
                  <Pressable testID="payment-add-button" onPress={addPayment} style={s.payAdd}><Text style={s.saveText}>Add</Text></Pressable>
                </View>
                <Pressable testID="payment-settle-button" onPress={settle} style={s.settleBtn}><Text style={s.settleBtnText}>Settle full due ({money(due)})</Text></Pressable>
              </>
            )}

            <Text style={s.detailSectionLabel}>PAYMENT HISTORY</Text>
            {payments.length === 0 ? <Text style={s.detailEmpty}>No payments recorded yet.</Text> : [...payments].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((p) => (
              <View key={p.id} testID="payment-history-row" style={s.detailRow}>
                <Text style={s.detailRowTitle}>{displayDate(p.date)}</Text>
                <View style={s.reminderRight}>
                  <Text style={[s.detailAmount, { color: C.income }]}>{money(p.amount)}</Text>
                  <Pressable testID="payment-delete" hitSlop={8} onPress={() => removePayment(p.id)}><MaterialCommunityIcons name="trash-can-outline" size={18} color={C.expense} /></Pressable>
                </View>
              </View>
            ))}
            <View style={{ height: 30 }} />
          </ScrollView>
          {showDate && <DatePickerModal value={date} title="Payment date" onSelect={(d) => { setDate(d); setShowDate(false); }} onClose={() => setShowDate(false)} />}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CategoryTrends({ incomes, expenses, year, monthIndex, monthName, colors }: { incomes: Income[]; expenses: Expense[]; year: number; monthIndex: number; monthName: string; colors: Record<string, string> }) {
  const prev = new Date(year, monthIndex - 1, 1);
  const prevName = new Intl.DateTimeFormat("en-IN", { month: "short" }).format(prev);
  const inMonth = (dateStr: string, y: number, m: number) => { const d = new Date(dateStr); return d.getFullYear() === y && d.getMonth() === m; };
  const incCats = Array.from(new Set(incomes.map((r) => r.product).filter(Boolean)));
  const expCats = Array.from(new Set(expenses.map((r) => r.category).filter(Boolean)));
  const rows = [
    ...incCats.map((cat) => ({
      cat, type: "income" as const,
      cur: incomes.filter((r) => r.product === cat && inMonth(r.date, year, monthIndex)).reduce((s, r) => s + r.amount, 0),
      prv: incomes.filter((r) => r.product === cat && inMonth(r.date, prev.getFullYear(), prev.getMonth())).reduce((s, r) => s + r.amount, 0),
    })),
    ...expCats.map((cat) => ({
      cat, type: "expense" as const,
      cur: expenses.filter((r) => r.category === cat && inMonth(r.date, year, monthIndex)).reduce((s, r) => s + expenseTotal(r), 0),
      prv: expenses.filter((r) => r.category === cat && inMonth(r.date, prev.getFullYear(), prev.getMonth())).reduce((s, r) => s + expenseTotal(r), 0),
    })),
  ].filter((r) => r.cur > 0 || r.prv > 0);
  if (rows.length === 0) return null;
  const withDelta = rows.map((r) => {
    const delta = r.cur - r.prv;
    const pct = r.prv > 0 ? (delta / r.prv) * 100 : (r.cur > 0 ? 100 : 0);
    return { ...r, delta, pct };
  }).sort((a, b) => b.pct - a.pct);
  const top = withDelta.find((r) => r.delta > 0);
  return (
    <View testID="category-trends" style={s.trendsCard}>
      <View style={s.insightsHead}>
        <Text style={s.insightsTitle}>CATEGORY TRENDS · VS {prevName.toUpperCase()}</Text>
        {top ? <Text style={s.insightsLeader}>↑ {top.cat}</Text> : null}
      </View>
      {withDelta.map((r) => {
        const up = r.delta > 0.009, down = r.delta < -0.009;
        const color = r.type === "income" ? (up ? C.income : down ? C.expense : C.muted) : (up ? C.expense : down ? C.income : C.muted);
        return (
          <View key={`${r.type}-${r.cat}`} testID={`trend-row-${r.cat.replace(/\s+/g, "-").toLowerCase()}`} style={s.trendRow}>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={[s.chipDot, { backgroundColor: colorFor(r.cat, colors) }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.trendCat} numberOfLines={1}>{r.cat}<Text style={s.trendType}>  {r.type === "income" ? "in" : "out"}</Text></Text>
                <Text style={s.trendMeta}>{money(r.prv)} → {money(r.cur)}</Text>
              </View>
            </View>
            <View style={s.trendDeltaWrap}>
              <MaterialCommunityIcons name={up ? "trending-up" : down ? "trending-down" : "trending-neutral"} size={16} color={color} />
              <Text style={[s.trendPct, { color }]}>{up ? "+" : ""}{Math.round(r.pct)}%</Text>
            </View>
          </View>
        );
      })}
      <Text style={s.trendHint}>{monthName} vs {prevName}. Up income & down expense are good.</Text>
    </View>
  );
}


function ProductInsights({ incomes, scope }: { incomes: Income[]; scope: string }) {
  const pith = incomes.filter((r) => r.product === "Coir Pith").reduce((sum, r) => sum + r.amount, 0);
  const bale = incomes.filter((r) => r.product === "Coir Bale").reduce((sum, r) => sum + r.amount, 0);
  if (pith + bale === 0) return null;
  const max = Math.max(pith, bale, 1);
  const leader = pith === bale ? "tie" : pith > bale ? "Coir Pith" : "Coir Bale";
  const items = [{ name: "Coir Pith", val: pith }, { name: "Coir Bale", val: bale }];
  return (
    <View testID="product-insights" style={s.insightsCard}>
      <View style={s.insightsHead}>
        <Text style={s.insightsTitle}>PRODUCT INSIGHTS · {scope.toUpperCase()}</Text>
        <Text style={s.insightsLeader}>{leader === "tie" ? "Even split" : `Top: ${leader}`}</Text>
      </View>
      {items.map((p) => (
        <View key={p.name} style={s.insightRow}>
          <Text style={s.insightName}>{p.name}</Text>
          <View style={s.insightTrack}><View style={[s.insightFill, { width: `${Math.round((p.val / max) * 100)}%`, backgroundColor: p.name === leader ? C.income : C.action }]} /></View>
          <Text style={s.insightVal}>{money(p.val)}</Text>
        </View>
      ))}
    </View>
  );
}

function LocalBackupsModal({ backups, onCreate, onRestore, onDelete, requestConfirm, onClose }: { backups: Backup[]; onCreate: () => void; onRestore: (b: Backup) => void; onDelete: (id: string) => void; requestConfirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void; onClose: () => void }) {
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>ON THIS DEVICE</Text>
              <Text style={s.formTitle}>Local backups</Text>
            </View>
            <Pressable testID="backups-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <ScrollView testID="local-backups-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
            <Pressable testID="create-backup-button" onPress={onCreate} style={s.createBackupBtn}>
              <MaterialCommunityIcons name="content-save-outline" size={18} color="#fff" />
              <Text style={s.saveText}>Back up now</Text>
            </Pressable>
            <Text style={s.detailSectionLabel}>SAVED BACKUPS</Text>
            {backups.length === 0 ? (
              <View style={s.empty}>
                <MaterialCommunityIcons name="database-outline" size={30} color={C.action} />
                <Text style={s.emptyTitle}>No local backups yet</Text>
                <Text style={s.emptyCopy}>Tap “Back up now” to save a snapshot on this device.</Text>
              </View>
            ) : backups.map((b) => (
              <View key={b.id} testID="local-backup-row" style={s.detailRow}>
                <View style={s.detailRowMain}>
                  <Text style={s.detailRowTitle}>{displayDateTime(b.createdAt)}</Text>
                  <Text style={s.reminderMeta}>{b.incomes.length} income · {b.expenses.length} expense</Text>
                </View>
                <View style={s.reminderRight}>
                  <Pressable testID="backup-restore-button" hitSlop={8} onPress={() => requestConfirm({ title: "Restore this backup?", message: `Replaces current data with ${b.incomes.length} income and ${b.expenses.length} expense records.`, confirmLabel: "Restore", onConfirm: () => onRestore(b) })} style={s.recordBtn}><Text style={s.recordBtnText}>Restore</Text></Pressable>
                  <Pressable testID="backup-delete-button" hitSlop={8} onPress={() => onDelete(b.id)}><MaterialCommunityIcons name="trash-can-outline" size={18} color={C.expense} /></Pressable>
                </View>
              </View>
            ))}
            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

type EntityTxn = { id: string; date: string; amount: number; label: string; due: number; photos: string[] };
type Entity = { name: string; phone: string; total: number; pending: number; txns: EntityTxn[] };
function VendorsModal({ incomes, expenses, onClose }: { incomes: Income[]; expenses: Expense[]; onClose: () => void }) {
  const [mode, setMode] = useState<"customers" | "suppliers">("customers");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const build = (isCustomer: boolean): Map<string, Entity> => {
    const map = new Map<string, Entity>();
    const ensure = (rawName: string, phone?: string) => {
      const key = (rawName || "").trim() || (isCustomer ? "Unnamed customer" : "Unnamed supplier");
      const cur = map.get(key) || { name: key, phone: "", total: 0, pending: 0, txns: [] };
      if (!cur.phone && phone) cur.phone = phone;
      map.set(key, cur);
      return cur;
    };
    if (isCustomer) incomes.forEach((r) => { const cur = ensure(r.name, r.phone); const due = dueOf(r); cur.total += r.amount; cur.pending += due; cur.txns.push({ id: r.id, date: r.date, amount: r.amount, label: describeRow(r), due, photos: photosOf(r) }); });
    else expenses.forEach((r) => { const cur = ensure(r.description, r.phone); const amt = expenseTotal(r); const due = expenseDue(r); cur.total += amt; cur.pending += due; cur.txns.push({ id: r.id, date: r.date, amount: amt, label: describeRow(r), due, photos: photosOf(r) }); });
    return map;
  };
  const isCustomer = mode === "customers";
  const map = build(isCustomer);
  const list = [...map.values()].sort((a, b) => b.pending - a.pending || b.total - a.total);
  const filteredList = q.trim() ? list.filter((v) => v.name.toLowerCase().includes(q.trim().toLowerCase())) : list;
  const active = selected ? map.get(selected) : null;
  const accent = isCustomer ? C.income : C.expense;

  const exportPdf = async (e: Entity) => {
    if (busy) return;
    setBusy(true);
    try {
      const html = buildEntityHTML(e.name, isCustomer, e.txns, e.total, e.pending);
      if (Platform.OS === "web") await Print.printAsync({ html });
      else { const { uri } = await Print.printToFileAsync({ html }); if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${e.name}`, UTI: "com.adobe.pdf" }); }
    } catch { /* cancelled */ } finally { setBusy(false); }
  };

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
              {active && <Pressable testID="vendor-detail-back" hitSlop={10} onPress={() => setSelected(null)} style={{ marginRight: 10 }}><MaterialCommunityIcons name="arrow-left" size={22} color={C.ink} /></Pressable>}
              <View style={{ flex: 1 }}>
                <Text style={s.detailOverline}>{active ? (isCustomer ? "CUSTOMER HISTORY" : "SUPPLIER HISTORY") : "TRANSACTION TOTALS"}</Text>
                <Text style={s.formTitle} numberOfLines={1}>{active ? active.name : "Contacts"}</Text>
              </View>
            </View>
            <Pressable testID="vendors-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>

          {!active && (
            <View style={[s.modeToggle, { marginHorizontal: 20, marginBottom: 4 }]}>
              <Pressable testID="vendors-tab-customers" onPress={() => { setMode("customers"); setQ(""); }} style={[s.modeBtn, isCustomer && s.modeBtnSel]}><Text style={[s.modeText, isCustomer && s.modeTextSel]}>Customers</Text></Pressable>
              <Pressable testID="vendors-tab-suppliers" onPress={() => { setMode("suppliers"); setQ(""); }} style={[s.modeBtn, !isCustomer && s.modeBtnSel]}><Text style={[s.modeText, !isCustomer && s.modeTextSel]}>Suppliers</Text></Pressable>
            </View>
          )}

          {!active && (
            <View style={[s.searchRow, { marginHorizontal: 20, marginBottom: 6 }]}>
              <MaterialCommunityIcons name="magnify" size={20} color={C.muted} />
              <TextInput testID="vendors-search-input" value={q} onChangeText={setQ} placeholder={isCustomer ? "Search customers…" : "Search suppliers…"} placeholderTextColor="#9DA49D" style={s.searchInput} returnKeyType="search" />
              {q ? <Pressable testID="vendors-search-clear" onPress={() => setQ("")}><MaterialCommunityIcons name="close-circle" size={19} color={C.muted} /></Pressable> : null}
            </View>
          )}

          {active ? (
            <ScrollView testID="vendor-detail-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
              <View style={s.detailSummary}>
                <View><Text style={s.panelLabel}>{isCustomer ? "PURCHASED" : "BILLED"}</Text><Text style={[s.smallAmount, { color: accent }]}>{money(active.total)}</Text></View>
                <View><Text style={s.panelLabel}>PAID</Text><Text style={[s.smallAmount, { color: C.income }]}>{money(active.total - active.pending)}</Text></View>
                <View><Text style={s.panelLabel}>PENDING</Text><Text style={[s.smallAmount, { color: C.action }]}>{money(active.pending)}</Text></View>
              </View>
              <Pressable testID="vendor-statement-button" onPress={() => exportPdf(active)} disabled={busy} style={[s.statementBtn, busy && s.exportDisabled]}>
                <MaterialCommunityIcons name="file-pdf-box" size={16} color={C.forest} />
                <Text style={s.statementBtnText}>{busy ? "Preparing…" : "Export statement (PDF)"}</Text>
              </Pressable>
              <Pressable testID="vendor-whatsapp-button" onPress={() => openWhatsApp(isCustomer ? waStatement(active.name, active.total, active.total - active.pending, active.pending) : waSupplier(active.name, active.total, active.pending), active.phone)} style={s.waBtn}>
                <MaterialCommunityIcons name="whatsapp" size={16} color="#fff" />
                <Text style={s.waBtnText}>Send on WhatsApp</Text>
              </Pressable>
              <Text style={s.detailSectionLabel}>{active.txns.length} TRANSACTION{active.txns.length === 1 ? "" : "S"}</Text>
              {[...active.txns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map((t) => (
                <View key={t.id} testID="vendor-txn-row" style={s.detailRow}>
                  <View style={s.detailRowMain}>
                    <Text style={s.detailRowTitle}>{t.label}</Text>
                    <Text style={s.reminderMeta}>{displayDate(t.date)}{t.due > 0.009 ? ` · due ${money(t.due)}` : " · paid"}</Text>
                  </View>
                  <Text style={[s.detailAmount, { color: accent }]}>{isCustomer ? "+ " : "− "}{money(t.amount)}</Text>
                </View>
              ))}
              <View style={{ height: 30 }} />
            </ScrollView>
          ) : (
            <ScrollView testID="vendors-modal" style={s.detailScroll} showsVerticalScrollIndicator={false}>
              {filteredList.length === 0 ? (
                <View style={s.empty}>
                  <MaterialCommunityIcons name="account-search-outline" size={30} color={C.action} />
                  <Text style={s.emptyTitle}>{q.trim() ? "No matches" : isCustomer ? "No customers yet" : "No suppliers yet"}</Text>
                  <Text style={s.emptyCopy}>{q.trim() ? "Try a different name." : isCustomer ? "Add income with a customer name to see totals." : "Add expenses with a supplier name to see totals."}</Text>
                </View>
              ) : filteredList.map((v) => (
                <Pressable key={v.name} testID="vendor-row" onPress={() => setSelected(v.name)} style={s.vendorRow}>
                  <View style={s.detailRowMain}>
                    <Text style={s.detailRowTitle}>{v.name}</Text>
                    <Text style={s.reminderMeta}>{v.txns.length} txn{v.txns.length === 1 ? "" : "s"}{v.pending > 0.009 ? ` · ${money(v.pending)} pending` : " · all paid"}</Text>
                  </View>
                  <View style={s.vendorTotals}>
                    <Text style={[s.vendorIncome, { color: accent }]} testID="vendor-total">{isCustomer ? "+ " : "− "}{money(v.total)}</Text>
                    {v.pending > 0.009 ? <Text style={s.vendorPending} testID="vendor-pending">{money(v.pending)} due</Text> : null}
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={18} color={C.line} />
                </Pressable>
              ))}
              <View style={{ height: 30 }} />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function CategoriesModal({ categories, onAdd, onDelete, onReorder, onSetColor, requestConfirm, onClose }: { categories: Categories; onAdd: (kind: "income" | "expense", name: string) => void; onDelete: (kind: "income" | "expense", name: string) => void; onReorder: (kind: "income" | "expense", next: string[]) => void; onSetColor: (name: string, color: string) => void; requestConfirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"income" | "expense">("income");
  const [newVal, setNewVal] = useState("");
  const [colorOpen, setColorOpen] = useState<string | null>(null);
  const list = mode === "income" ? categories.income : categories.expense;

  const renderItem = ({ item, drag, isActive }: RenderItemParams<string>) => (
    <View testID={`category-row-${mode}`} style={[s.catRow, isActive && s.catRowActive]}>
      <View style={s.catRowTop}>
        <Pressable testID={`category-drag-${mode}`} onLongPress={drag} delayLongPress={120} hitSlop={8} style={{ paddingRight: 6 }}>
          <MaterialCommunityIcons name="drag-vertical" size={22} color={C.muted} />
        </Pressable>
        <Pressable testID={`category-color-${mode}`} hitSlop={10} onPress={() => setColorOpen((v) => (v === item ? null : item))} style={[s.catSwatch, { backgroundColor: colorFor(item, categories.colors) }]} />
        <Text style={[s.catName, { flex: 1 }]} numberOfLines={1}>{item}</Text>
        <Pressable testID={`category-delete-${mode}`} hitSlop={8} onPress={() => requestConfirm({ title: `Remove "${item}"?`, message: "It won't appear when adding new entries. Existing records keep this label.", confirmLabel: "Remove", onConfirm: () => onDelete(mode, item) })}>
          <MaterialCommunityIcons name="trash-can-outline" size={19} color={C.expense} />
        </Pressable>
      </View>
      {colorOpen === item && (
        <View testID={`category-palette-${mode}`} style={s.catPaletteRow}>
          {CAT_PALETTE.map((col) => (
            <Pressable key={col} testID={`palette-${col}`} onPress={() => { onSetColor(item, col); setColorOpen(null); }} style={[s.catPaletteDot, { backgroundColor: col }, colorFor(item, categories.colors) === col && s.catPaletteDotSel]} />
          ))}
        </View>
      )}
    </View>
  );

  const add = () => { if (newVal.trim()) { onAdd(mode, newVal); setNewVal(""); } };

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>MANAGE CATEGORIES</Text>
              <Text style={s.formTitle}>Categories</Text>
            </View>
            <Pressable testID="categories-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <View style={[s.modeToggle, { marginHorizontal: 20, marginBottom: 6 }]}>
            <Pressable testID="categories-tab-income" onPress={() => { setMode("income"); setColorOpen(null); }} style={[s.modeBtn, mode === "income" && s.modeBtnSel]}><Text style={[s.modeText, mode === "income" && s.modeTextSel]}>Income products</Text></Pressable>
            <Pressable testID="categories-tab-expense" onPress={() => { setMode("expense"); setColorOpen(null); }} style={[s.modeBtn, mode === "expense" && s.modeBtnSel]}><Text style={[s.modeText, mode === "expense" && s.modeTextSel]}>Expense categories</Text></Pressable>
          </View>
          <Text style={[s.trendHint, { marginHorizontal: 20, marginBottom: 4 }]}>Hold the ⋮⋮ handle to drag & reorder. Tap the colour dot to recolour.</Text>
          <View testID="categories-modal" style={{ flex: 1, paddingHorizontal: 20 }}>
            <DraggableFlatList
              data={list}
              keyExtractor={(item) => `${mode}-${item}`}
              renderItem={renderItem}
              onDragEnd={({ data }) => onReorder(mode, data)}
              activationDistance={12}
              containerStyle={{ flexGrow: 0 }}
              ListEmptyComponent={<Text style={[s.emptyCopy, { textAlign: "left", marginVertical: 12 }]}>No categories yet. Add one below.</Text>}
            />
          </View>
          <View style={[s.newCatRow, { marginHorizontal: 20, marginBottom: 24 }]}>
            <TextInput testID={`category-input-${mode}`} value={newVal} onChangeText={setNewVal} placeholder={mode === "income" ? "Add product (e.g. Coir Rope)" : "Add category (e.g. Rent)"} placeholderTextColor="#9DA49D" style={[s.textInputBox, { flex: 1 }]} returnKeyType="done" onSubmitEditing={add} />
            <Pressable testID={`category-add-${mode}`} onPress={add} style={s.newCatSave}><Text style={s.newCatSaveText}>Add</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ProfileModal({ profile, onSave, onClose }: { profile: Profile; onSave: (p: Profile) => void; onClose: () => void }) {
  const [company, setCompany] = useState(profile.company);
  const [user, setUser] = useState(profile.user);
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.modalWrap}>
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <View style={[s.formHead, s.detailHeaderPad]}>
            <View>
              <Text style={s.detailOverline}>BUSINESS PROFILE</Text>
              <Text style={s.formTitle}>Edit profile</Text>
            </View>
            <Pressable testID="profile-close" onPress={onClose}><MaterialCommunityIcons name="close" size={24} color={C.ink} /></Pressable>
          </View>
          <ScrollView style={s.detailScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={s.inputLabel}>COMPANY NAME</Text>
            <TextInput testID="profile-company-input" value={company} onChangeText={setCompany} placeholder="e.g. SVKD COIR" placeholderTextColor="#9DA49D" style={s.textInputBox} returnKeyType="next" />
            <Text style={[s.inputLabel, { marginTop: 14 }]}>YOUR NAME</Text>
            <TextInput testID="profile-user-input" value={user} onChangeText={setUser} placeholder="e.g. Kumar" placeholderTextColor="#9DA49D" style={s.textInputBox} returnKeyType="done" />
            <Text style={[s.trendHint, { marginTop: 12 }]}>Company name shows in the app header and on all PDFs. Your name is used in the greeting.</Text>
            <Pressable testID="profile-save-button" onPress={() => onSave({ company: company.trim() || DEFAULT_PROFILE.company, user: user.trim() || DEFAULT_PROFILE.user })} style={[s.save, { marginTop: 20 }]}>
              <Text style={s.saveText}>Save profile</Text>
            </Pressable>
            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}


const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const pdfStyle = `* { box-sizing: border-box; } body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1F2924; padding: 28px; } h1 { font-size: 22px; margin: 0; } .sub { color: #59635C; font-size: 12px; margin: 4px 0 20px; } .cards { display: flex; gap: 12px; margin-bottom: 22px; } .card { flex: 1; border: 1px solid #D8D1C4; border-radius: 8px; padding: 12px 14px; } .card .k { font-size: 10px; letter-spacing: 1px; color: #59635C; text-transform: uppercase; } .card .v { font-size: 18px; font-weight: 700; margin-top: 6px; } .inc { color: #2F7D57; } .exp { color: #B65A43; } h2 { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: #C76B35; margin: 22px 0 8px; } table { width: 100%; border-collapse: collapse; font-size: 12px; } th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #E6DFD2; } th { background: #F0E9DC; font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: #59635C; } td.amt, th.amt { text-align: right; font-variant-numeric: tabular-nums; } td.empty { text-align: center; color: #9DA49D; font-style: italic; } tfoot td { font-weight: 700; border-top: 2px solid #1F2924; } .foot { margin-top: 26px; font-size: 10px; color: #9DA49D; } .receipts { margin-top: 8px; } .receipt { margin-bottom: 16px; page-break-inside: avoid; } .receipt .rcap { font-size: 11px; color: #59635C; margin-bottom: 6px; } .receipt img { max-width: 100%; max-height: 340px; border: 1px solid #D8D1C4; border-radius: 6px; }`;

function buildMonthHTML(monthName: string, incs: Income[], exps: Expense[], totIn: number, totEx: number) {
  const incRows = incs.length
    ? incs.map((r) => `<tr><td>${displayDate(r.date)}</td><td>${escapeHtml(r.product)}</td><td>${escapeHtml(r.name)}</td><td>${dueOf(r) > 0 ? "Pending" : "Paid"}</td><td class="amt">${escapeHtml(money(r.amount))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No income recorded</td></tr>`;
  const expRows = exps.length
    ? exps.map((r) => `<tr><td>${displayDate(r.date)}</td><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.description || (r.category === "Husk" && r.trips ? `${r.trips} trips @ ₹${r.costPerTon}/trip` : ""))}</td><td class="amt">${escapeHtml(money(r.amount + (r.repairAmount || 0)))}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No expenses recorded</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${pdfStyle}</style></head><body>
    <h1>${escapeHtml(BRAND)}</h1>
    <div class="sub">${escapeHtml(monthName)} · Generated ${escapeHtml(displayDate(new Date().toISOString()))}</div>
    <div class="cards">
      <div class="card"><div class="k">Total Income</div><div class="v inc">${escapeHtml(money(totIn))}</div></div>
      <div class="card"><div class="k">Total Expenses</div><div class="v exp">${escapeHtml(money(totEx))}</div></div>
      <div class="card"><div class="k">Net Balance</div><div class="v" style="color:${totIn - totEx >= 0 ? "#2F7D57" : "#B65A43"}">${escapeHtml(money(totIn - totEx))}</div></div>
    </div>
    <h2>Income</h2>
    <table><thead><tr><th>Date</th><th>Product</th><th>Name</th><th>Status</th><th class="amt">Amount</th></tr></thead>
    <tbody>${incRows}</tbody><tfoot><tr><td colspan="4">Total income</td><td class="amt">${escapeHtml(money(totIn))}</td></tr></tfoot></table>
    <h2>Expenses</h2>
    <table><thead><tr><th>Date</th><th>Category</th><th>Details</th><th class="amt">Amount</th></tr></thead>
    <tbody>${expRows}</tbody><tfoot><tr><td colspan="3">Total expenses</td><td class="amt">${escapeHtml(money(totEx))}</td></tr></tfoot></table>
    ${receiptsHTML([
      ...incs.map((r) => ({ date: r.date, label: `${r.product}${r.name ? ` · ${r.name}` : ""}`, photos: photosOf(r) })),
      ...exps.map((r) => ({ date: r.date, label: `${r.category}${r.description ? ` · ${r.description}` : ""}`, photos: photosOf(r) })),
    ].flatMap((x) => x.photos.map((p) => ({ date: x.date, label: x.label, photo: p }))))}
    <div class="foot">Stored on device · ${escapeHtml(BRAND)}</div>
  </body></html>`;
}

function receiptsHTML(items: { date: string; label: string; photo?: string }[]) {
  const withPhoto = items.filter((i) => i.photo);
  if (withPhoto.length === 0) return "";
  return `<h2>Receipts</h2><div class="receipts">${withPhoto.map((i) => `<div class="receipt"><div class="rcap">${escapeHtml(displayDate(i.date))} · ${escapeHtml(i.label)}</div><img src="${i.photo}" /></div>`).join("")}</div>`;
}

function buildCustomerHTML(name: string, records: Income[], total: number, pending: number) {
  const sorted = [...records].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const rows = sorted.map((r) => `<tr><td>${displayDate(r.date)}</td><td>${escapeHtml(r.product)}</td><td>${r.tons ? escapeHtml(`${r.tons}t @ ₹${r.costPerTon}/t`) : "—"}</td><td>${dueOf(r) > 0 ? `Due ${escapeHtml(money(dueOf(r)))}` : "Paid"}</td><td class="amt">${escapeHtml(money(r.amount))}</td></tr>`).join("");
  const receipts = receiptsHTML(sorted.flatMap((r) => photosOf(r).map((p) => ({ date: r.date, label: `${r.product}${r.name ? ` · ${r.name}` : ""}`, photo: p }))));
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${pdfStyle}</style></head><body>
    <h1>Statement · ${escapeHtml(name)}</h1>
    <div class="sub">${escapeHtml(BRAND)} · Generated ${escapeHtml(displayDate(new Date().toISOString()))}</div>
    <div class="cards">
      <div class="card"><div class="k">Total Purchased</div><div class="v inc">${escapeHtml(money(total))}</div></div>
      <div class="card"><div class="k">Amount Paid</div><div class="v">${escapeHtml(money(total - pending))}</div></div>
      <div class="card"><div class="k">Outstanding Due</div><div class="v exp">${escapeHtml(money(pending))}</div></div>
    </div>
    <h2>Purchases</h2>
    <table><thead><tr><th>Date</th><th>Product</th><th>Qty / Rate</th><th>Status</th><th class="amt">Amount</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="empty">No purchases</td></tr>`}</tbody>
    <tfoot><tr><td colspan="4">Outstanding due</td><td class="amt">${escapeHtml(money(pending))}</td></tr></tfoot></table>
    ${receipts}
    <div class="foot">Thank you for your business · ${escapeHtml(BRAND)}</div>
  </body></html>`;
}

function buildEntityHTML(name: string, isCustomer: boolean, txns: EntityTxn[], total: number, pending: number) {
  const sorted = [...txns].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const rows = sorted.map((t) => `<tr><td>${displayDate(t.date)}</td><td>${escapeHtml(t.label)}</td><td>${t.due > 0.009 ? `Due ${escapeHtml(money(t.due))}` : "Paid"}</td><td class="amt">${escapeHtml(money(t.amount))}</td></tr>`).join("");
  const receipts = receiptsHTML(sorted.flatMap((t) => t.photos.map((p) => ({ date: t.date, label: t.label, photo: p }))));
  const totalLabel = isCustomer ? "Total Purchased" : "Total Billed";
  const dueLabel = isCustomer ? "Outstanding Due" : "Balance to Pay";
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${pdfStyle}</style></head><body>
    <h1>Statement · ${escapeHtml(name)}</h1>
    <div class="sub">${escapeHtml(BRAND)} · ${isCustomer ? "Customer" : "Supplier"} · Generated ${escapeHtml(displayDate(new Date().toISOString()))}</div>
    <div class="cards">
      <div class="card"><div class="k">${totalLabel}</div><div class="v ${isCustomer ? "inc" : "exp"}">${escapeHtml(money(total))}</div></div>
      <div class="card"><div class="k">Paid</div><div class="v">${escapeHtml(money(total - pending))}</div></div>
      <div class="card"><div class="k">${dueLabel}</div><div class="v exp">${escapeHtml(money(pending))}</div></div>
    </div>
    <h2>Transactions</h2>
    <table><thead><tr><th>Date</th><th>Details</th><th>Status</th><th class="amt">Amount</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="empty">No transactions</td></tr>`}</tbody>
    <tfoot><tr><td colspan="3">${dueLabel}</td><td class="amt">${escapeHtml(money(pending))}</td></tr></tfoot></table>
    ${receipts}
    <div class="foot">${isCustomer ? "Thank you for your business" : "Statement for your records"} · ${escapeHtml(BRAND)}</div>
  </body></html>`;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  header: { height: 70, paddingHorizontal: 20, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 24, fontWeight: "700", color: C.ink },
  localRow: { flexDirection: "row", alignItems: "center", marginTop: 3 },
  local: { color: C.muted, fontSize: 12 },
  dot: { width: 7, height: 7, backgroundColor: C.income, borderRadius: 4, marginRight: 4 },
  content: { padding: 20, paddingBottom: 150 },
  overline: { color: C.action, fontSize: 11, fontWeight: "800", letterSpacing: 2, marginBottom: 15 },
  greeting: { fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 29, fontWeight: "700", color: C.ink },
  dateContext: { color: C.muted, fontSize: 14, marginTop: 6, marginBottom: 22 },
  summary: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, flexDirection: "row", marginBottom: 16 },
  netPanel: { backgroundColor: C.forest, padding: 18, flex: 1.1, minHeight: 140 },
  panelLabel: { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  panelLabelDark: { color: "#C7D5CA", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  netAmount: { color: C.surface, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 25, fontWeight: "700", marginTop: 18 },
  netNote: { color: "#C7D5CA", fontSize: 11, marginTop: 10, lineHeight: 16 },
  smallTotals: { flex: 0.9, padding: 18, justifyContent: "center", gap: 15 },
  smallAmount: { fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 16, fontWeight: "700", marginTop: 5 },
  divider: { height: 1, backgroundColor: C.line },
  outstandingPill: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F7EAD8", borderWidth: 1, borderColor: "#E6C89A", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 18 },
  outstandingText: { flex: 1, color: C.ink, fontSize: 13 },
  outstandingStrong: { fontWeight: "800", color: C.action },
  positionCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginBottom: 18 },
  positionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  positionTitle: { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  positionCta: { flexDirection: "row", alignItems: "center" },
  positionCtaText: { color: C.action, fontSize: 11, fontWeight: "800" },
  positionRow: { flexDirection: "row", alignItems: "center" },
  positionCol: { flex: 1 },
  positionLabelRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 5 },
  positionLabel: { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  positionAmount: { fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 18, fontWeight: "700" },
  positionDivider: { width: 1, alignSelf: "stretch", backgroundColor: C.line, marginHorizontal: 14 },
  positionNetRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line },
  positionNetLabel: { color: C.ink, fontSize: 13, fontWeight: "700" },
  positionNetAmount: { fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 16, fontWeight: "800" },

  tabs: { backgroundColor: "#E9E2D7", padding: 4, flexDirection: "row", borderRadius: 22, marginBottom: 16 },
  tab: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 19 },
  selectedTab: { backgroundColor: C.forest },
  tabText: { color: C.muted, fontSize: 13, fontWeight: "700" },
  selectedTabText: { color: C.surface },
  filtersWrap: { marginBottom: 18, gap: 10 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 48 },
  searchInput: { flex: 1, color: C.ink, fontSize: 15, paddingVertical: 10 },
  dateRangeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dateChip: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 42, paddingHorizontal: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10 },
  dateChipText: { color: C.ink, fontSize: 13, fontWeight: "700" },
  dateChipPlaceholder: { color: "#9DA49D", fontWeight: "600" },
  dateClear: { minHeight: 42, paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
  dateClearText: { color: C.expense, fontSize: 12, fontWeight: "800" },
  section: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, marginBottom: 20 },
  sectionHead: { padding: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionOverline: { color: C.action, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  sectionTitle: { color: C.ink, fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 21, fontWeight: "700", marginTop: 3 },
  addLink: { minHeight: 44, paddingHorizontal: 10, flexDirection: "row", gap: 4, alignItems: "center" },
  addLinkText: { color: C.forest, fontWeight: "800" },
  filterRow: { maxHeight: 56, borderTopWidth: 1, borderTopColor: C.line },
  filterRowContent: { paddingHorizontal: 14, paddingVertical: 10, gap: 8, alignItems: "center" },
  chip: { flexShrink: 0, flexDirection: "row", height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center", backgroundColor: C.surface },
  chipSelected: { backgroundColor: C.forest, borderColor: C.forest },
  chipText: { color: C.muted, fontSize: 12, fontWeight: "700" },
  chipTextSelected: { color: "#fff" },
  pendingChip: { flexDirection: "row", gap: 5, borderColor: "#E6C89A", backgroundColor: "#FBF2E4" },
  pendingChipSelected: { backgroundColor: C.action, borderColor: C.action },

  tableHeader: { flexDirection: "row", padding: 11, backgroundColor: "#F0E9DC", borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line },
  cell: { flex: 1, color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  dateCell: { width: 78, flex: 0 },
  amountCell: { textAlign: "right", width: 100, flex: 0 },
  actionCell: { width: 65 },
  row: { minHeight: 62, paddingHorizontal: 11, paddingVertical: 8, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: C.line },
  rowText: { color: C.ink, fontSize: 12 },
  rowActions: { width: 65, flexDirection: "row", justifyContent: "space-between", paddingLeft: 10 },
  badge: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", marginTop: 6, minHeight: 24, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  badgePending: { backgroundColor: "#F7EAD8", borderColor: "#E6C89A" },
  badgePart: { backgroundColor: "#E1ECF7", borderColor: "#B4CDE8" },
  badgePaid: { backgroundColor: "#E4F0E8", borderColor: "#B9D8C4" },
  badgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  photoButtons: { flexDirection: "row", gap: 10, marginTop: 4 },
  photoBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, paddingHorizontal: 6 },
  photoBtnText: { color: C.forest, fontSize: 12, fontWeight: "700" },
  photoPermBox: { marginTop: 8, backgroundColor: "#FBECE7", borderRadius: 8, padding: 12, gap: 8 },
  photoPermText: { color: C.expense, fontSize: 12, lineHeight: 17 },
  photoSettingsBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, alignSelf: "flex-start", backgroundColor: C.expense, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  photoSettingsText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  rowPhotoWrap: { marginTop: 8, width: 52, height: 52, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: C.line, position: "relative" },
  rowPhoto: { width: "100%", height: "100%", backgroundColor: "#EEE8DC" },
  rowPhotoBadge: { position: "absolute", bottom: 0, right: 0, backgroundColor: "rgba(31,41,36,0.7)", paddingHorizontal: 3, paddingVertical: 2, borderTopLeftRadius: 6, flexDirection: "row", alignItems: "center", gap: 2 },
  rowPhotoCount: { color: "#fff", fontSize: 9, fontWeight: "800" },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, marginTop: 2 },
  photoThumbBox: { width: 72, height: 72, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: C.line, position: "relative" },
  photoThumbImg: { width: "100%", height: "100%", backgroundColor: "#EEE8DC" },
  photoThumbRemove: { position: "absolute", top: 3, right: 3, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(31,41,36,0.72)", alignItems: "center", justifyContent: "center" },
  photoViewerWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  photoViewerBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  photoViewerImage: { width: "92%", height: "80%" },
  photoViewerClose: { position: "absolute", top: 50, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },
  photoNav: { position: "absolute", top: "48%", width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },
  photoCounter: { position: "absolute", bottom: 46, alignSelf: "center", backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12 },
  photoCounterText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  optionAdd: { borderColor: C.action, borderStyle: "dashed", backgroundColor: "#FBF2E4" },
  newCatRow: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8, marginBottom: 4 },
  newCatSave: { backgroundColor: C.forest, paddingHorizontal: 16, minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  newCatSaveText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  catRow: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.line },
  catRowActive: { backgroundColor: C.canvas, borderRadius: 8 },
  catRowTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  catName: { fontSize: 15, fontWeight: "600", color: C.ink },
  catSwatch: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: "rgba(0,0,0,0.12)" },
  catPaletteRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 10, paddingLeft: 38 },
  catPaletteDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  catPaletteDotSel: { borderColor: C.ink },
  chipDot: { width: 9, height: 9, borderRadius: 5, marginRight: 6 },

  empty: { padding: 25, alignItems: "center" },
  emptyTitle: { color: C.ink, fontWeight: "800", marginTop: 10 },
  emptyCopy: { color: C.muted, fontSize: 13, textAlign: "center", marginTop: 5 },
  fabRow: { position: "absolute", bottom: 78, right: 16, flexDirection: "row", gap: 8 },
  fab: { minHeight: 44, paddingHorizontal: 14, borderRadius: 24, flexDirection: "row", alignItems: "center", gap: 5, elevation: 3 },
  fabText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  nav: { position: "absolute", bottom: 0, left: 0, right: 0, height: 72, paddingBottom: Platform.OS === "ios" ? 12 : 4, backgroundColor: C.nav, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  navItem: { minWidth: 60, minHeight: 50, alignItems: "center", justifyContent: "center" },
  navText: { color: "#B8C1B9", fontSize: 10, marginTop: 3, fontWeight: "700" },
  modalWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(23,60,44,.35)" },
  sheet: { backgroundColor: C.surface, maxHeight: "88%", borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  sheetContent: { padding: 20, paddingBottom: Platform.OS === "ios" ? 40 : 28 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: C.line, alignSelf: "center", marginTop: 12, marginBottom: 14 },
  formHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  formTitle: { color: C.ink, fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 26, fontWeight: "700", textTransform: "capitalize" },
  dateLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  todayLink: { color: C.forest, fontSize: 13, fontWeight: "800" },
  inputLabel: { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8, marginTop: 10 },
  inputRow: { minHeight: 50, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  inputValue: { flex: 1, color: C.ink, fontSize: 15 },
  textInputBox: { minHeight: 48, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, color: C.ink, fontSize: 15 },
  textInputSmall: { flex: 1, color: C.ink, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 15 },
  twoCol: { flexDirection: "row", gap: 12 },
  colItem: { flex: 1 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { minHeight: 44, borderWidth: 1, borderColor: C.line, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 6 },
  optionSelected: { backgroundColor: C.forest, borderColor: C.forest },
  optionSelectedWarn: { backgroundColor: C.action, borderColor: C.action },
  optionText: { color: C.ink, fontSize: 13, fontWeight: "700" },
  optionTextSelected: { color: "#fff" },
  amountModeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  manualToggle: { color: C.forest, fontSize: 12, fontWeight: "800", marginTop: 10 },
  amountInput: { minHeight: 52, borderWidth: 1, borderColor: C.line, flexDirection: "row", alignItems: "center", paddingHorizontal: 14 },
  errorBorder: { borderColor: C.expense },
  rupee: { color: C.forest, fontSize: 20, fontWeight: "700", marginRight: 8 },
  textInput: { flex: 1, color: C.ink, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 18 },
  error: { color: C.expense, fontSize: 12, marginTop: 5 },
  formButtons: { flexDirection: "row", gap: 10, marginTop: 25 },
  cancel: { flex: 1, minHeight: 50, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.line },
  cancelText: { color: C.ink, fontWeight: "800" },
  save: { flex: 1.4, minHeight: 50, backgroundColor: C.forest, alignItems: "center", justifyContent: "center" },
  saveText: { color: "#fff", fontWeight: "800" },
  productionBox: { marginTop: 14, padding: 12, backgroundColor: "#F0E9DC", borderWidth: 1, borderColor: C.line },
  productionTitle: { color: C.action, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  productionText: { color: C.muted, fontSize: 12, marginTop: 7 },
  productionStrong: { color: C.ink, fontWeight: "800" },
  outputRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line },
  outputText: { color: C.muted, fontSize: 11 },
  outputValue: { color: C.forest, fontSize: 12, fontWeight: "800" },
  modeToggle: { flexDirection: "row", backgroundColor: "#E9E2D7", borderRadius: 22, padding: 4, marginBottom: 14 },
  modeBtn: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 18 },
  modeBtnSel: { backgroundColor: C.forest },
  modeText: { color: C.muted, fontSize: 13, fontWeight: "700" },
  modeTextSel: { color: "#fff" },
  calendarHead: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  calendarTitle: { color: C.ink, fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 20, fontWeight: "700" },
  calendarSummary: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderTopWidth: 0, padding: 14, flexDirection: "row", justifyContent: "space-between" },
  calendarIncome: { color: C.income, fontSize: 14, fontWeight: "700" },
  calendarExpense: { color: C.expense, fontSize: 14, fontWeight: "700" },
  calendarNet: { color: C.ink, fontSize: 14, fontWeight: "700" },
  exportButton: { marginTop: 14, minHeight: 50, borderRadius: 10, backgroundColor: C.forest, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  exportDisabled: { opacity: 0.5 },
  exportText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  calendarLegend: { flexDirection: "row", gap: 18, alignItems: "center", paddingVertical: 14 },
  legendIncome: { color: C.income, fontSize: 12, fontWeight: "700" },
  legendExpense: { color: C.expense, fontSize: 12, fontWeight: "700" },
  legendHint: { color: C.muted, fontSize: 11, marginLeft: "auto", fontStyle: "italic" },
  chartCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14 },
  chartBars: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  chartCol: { flex: 1, alignItems: "center" },
  chartPair: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 150 },
  barIncome: { width: 7, backgroundColor: C.income, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  barExpense: { width: 7, backgroundColor: C.expense, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  chartMonth: { color: C.muted, fontSize: 9, fontWeight: "700", marginTop: 6 },
  bestWorst: { marginTop: 14, gap: 8 },
  bwItem: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12 },
  bwText: { color: C.ink, fontSize: 13 },
  bwStrong: { fontWeight: "800" },
  dayRow: { backgroundColor: C.surface, minHeight: 68, borderWidth: 1, borderColor: C.line, borderBottomWidth: 0, padding: 12, flexDirection: "row", alignItems: "center", gap: 4 },
  dayDate: { width: 52 },
  dayNumber: { color: C.ink, fontSize: 20, fontWeight: "800" },
  dayName: { color: C.muted, fontSize: 11, marginTop: 2 },
  dayValues: { flex: 1, gap: 5 },
  dayIncome: { color: C.income, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 12 },
  dayExpense: { color: C.expense, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 12 },
  dayMuted: { color: C.line, fontSize: 12 },
  dayNet: { width: 86, textAlign: "right", fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 12, fontWeight: "800" },
  detailOverline: { color: C.action, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 4 },
  detailHeaderPad: { paddingHorizontal: 20, marginTop: 4 },
  detailScroll: { paddingHorizontal: 20 },
  detailSummary: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#F0E9DC", borderRadius: 10, padding: 14, marginBottom: 8 },
  detailSectionLabel: { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginTop: 18, marginBottom: 8 },
  detailEmpty: { color: C.muted, fontSize: 13, fontStyle: "italic" },
  detailRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, gap: 10 },
  detailRowMain: { flex: 1 },
  detailRowTitle: { color: C.ink, fontSize: 14, fontWeight: "600" },
  detailStatus: { fontSize: 11, fontWeight: "800", marginTop: 3 },
  detailAmount: { fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 14, fontWeight: "800" },
  reminderChips: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  reminderTotal: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#F7EAD8", borderWidth: 1, borderColor: "#E6C89A", borderRadius: 10, padding: 14, marginTop: 14 },
  reminderTotalLabel: { color: C.ink, fontSize: 13, fontWeight: "700" },
  reminderTotalAmt: { color: C.action, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 16, fontWeight: "800" },
  reminderMeta: { color: C.muted, fontSize: 12, marginTop: 3 },
  reminderRight: { alignItems: "flex-end", gap: 6 },
  markPaid: { backgroundColor: C.forest, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  markPaidText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  customerRow: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginTop: 12 },
  customerTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  customerName: { color: C.ink, fontSize: 16, fontWeight: "800" },
  customerMeta: { color: C.muted, fontSize: 12, marginTop: 3 },
  statementBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 12, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: C.forest },
  statementBtnText: { color: C.forest, fontSize: 13, fontWeight: "800" },
  settings: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  settingRow: { padding: 18, borderBottomWidth: 1, borderBottomColor: C.line, flexDirection: "row", gap: 14, alignItems: "center" },
  settingCopy: { flex: 1 },
  settingTitle: { color: C.ink, fontSize: 15, fontWeight: "800" },
  settingSub: { color: C.muted, fontSize: 13, marginTop: 4, lineHeight: 18 },
  settingsNotice: { color: C.forest, fontSize: 13, fontWeight: "700", padding: 16, backgroundColor: "#E4F0E8", borderBottomWidth: 1, borderBottomColor: C.line },
  clearButton: { minHeight: 56, paddingHorizontal: 18, flexDirection: "row", gap: 10, alignItems: "center" },
  clearText: { color: C.expense, fontWeight: "800" },
  confirmWrap: { flex: 1, justifyContent: "center", alignItems: "center", padding: 28, backgroundColor: "rgba(23,60,44,.45)" },
  confirmCard: { width: "100%", backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 22 },
  confirmTitle: { color: C.ink, fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 20, fontWeight: "700" },
  confirmMessage: { color: C.muted, fontSize: 14, marginTop: 8, lineHeight: 20 },
  confirmButtons: { flexDirection: "row", gap: 10, marginTop: 22 },
  confirmDanger: { flex: 1.4, minHeight: 50, backgroundColor: C.expense, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  recordBtn: { borderWidth: 1, borderColor: C.forest, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  recordBtnText: { color: C.forest, fontSize: 12, fontWeight: "800" },
  createBackupBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, borderRadius: 8, backgroundColor: C.forest, marginTop: 4 },
  waBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 8, minHeight: 44, borderRadius: 8, backgroundColor: "#128C7E" },
  waBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  waSmall: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#128C7E", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  waSmallText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  suggestBox: { borderWidth: 1, borderTopWidth: 0, borderColor: C.line, backgroundColor: C.surface, marginTop: -1 },
  suggestItem: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: "#EDE6D8" },
  suggestText: { flex: 1, color: C.ink, fontSize: 14 },
  vendorRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, gap: 10 },
  vendorTotals: { alignItems: "flex-end", gap: 3 },
  vendorIncome: { color: C.income, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 13, fontWeight: "800" },
  vendorExpense: { color: C.expense, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 13, fontWeight: "800" },
  vendorPending: { color: C.action, fontSize: 11, fontWeight: "700", marginTop: 2 },
  breakdownCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, marginBottom: 12 },
  breakdownHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  breakdownTitle: { fontSize: 10, letterSpacing: 1, fontWeight: "800", color: C.muted },
  breakdownLegend: { flexDirection: "row", gap: 10 },
  breakdownLegendReceived: { fontSize: 9, fontWeight: "800", color: C.income },
  breakdownLegendPending: { fontSize: 9, fontWeight: "800", color: C.action },
  breakdownRow: { flexDirection: "row", alignItems: "center", paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.line },
  breakdownCatCol: { flex: 1 },
  breakdownCat: { fontSize: 13, fontWeight: "700", color: C.ink },
  breakdownCount: { fontSize: 11, color: C.muted, marginTop: 1 },
  breakdownReceived: { width: 100, textAlign: "right", color: C.income, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 12, fontWeight: "800" },
  breakdownPending: { width: 100, textAlign: "right", color: C.action, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 12, fontWeight: "800" },

  payRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  payAdd: { minWidth: 72, paddingHorizontal: 16, backgroundColor: C.forest, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  settleBtn: { marginTop: 10, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: C.forest, alignItems: "center", justifyContent: "center" },
  settleBtnText: { color: C.forest, fontWeight: "800", fontSize: 13 },
  insightsCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginTop: 14 },
  insightsHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  insightsTitle: { color: C.action, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  insightsLeader: { color: C.forest, fontSize: 11, fontWeight: "800" },
  trendsCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginTop: 14 },
  trendRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line },
  trendCat: { fontSize: 13, fontWeight: "700", color: C.ink },
  trendType: { fontSize: 10, fontWeight: "700", color: C.muted },
  trendMeta: { fontSize: 11, color: C.muted, marginTop: 2, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }) },
  trendDeltaWrap: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 74, justifyContent: "flex-end" },
  trendPct: { fontSize: 13, fontWeight: "800" },
  trendHint: { fontSize: 10, color: C.muted, marginTop: 10, fontStyle: "italic" },

  insightRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  insightName: { width: 68, color: C.ink, fontSize: 12, fontWeight: "700" },
  insightTrack: { flex: 1, height: 10, backgroundColor: "#F0E9DC", borderRadius: 5, overflow: "hidden" },
  insightFill: { height: 10, borderRadius: 5 },
  insightVal: { width: 84, textAlign: "right", color: C.ink, fontFamily: Platform.select({ ios: "Courier New", default: "monospace" }), fontSize: 11, fontWeight: "800" },
  datePickerCard: { width: "100%", backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18 },
  dpHeading: { color: C.action, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 10 },
  dpHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  dpTitle: { color: C.ink, fontSize: 16, fontWeight: "800" },
  dpWeekRow: { flexDirection: "row" },
  dpWeek: { flexBasis: "14.28%", textAlign: "center", color: C.muted, fontSize: 11, fontWeight: "800", paddingVertical: 6 },
  dpGrid: { flexDirection: "row", flexWrap: "wrap" },
  dpCell: { flexBasis: "14.28%", height: 40, alignItems: "center", justifyContent: "center" },
  dpCellSel: { },
  dpDay: { color: C.ink, fontSize: 14, width: 34, height: 34, borderRadius: 17, textAlign: "center", textAlignVertical: "center", lineHeight: 34 },
  dpDaySel: { backgroundColor: C.forest, color: "#fff", overflow: "hidden", fontWeight: "800" },
  dpFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line },
  dpCloseText: { color: C.muted, fontSize: 14, fontWeight: "800" },
});
