import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "./markdown.css";
import { Welcome } from "./components/Welcome";
import { TopToolbar } from "./components/TopToolbar";
import { LeftSidebar } from "./components/LeftSidebar";
import { PdfWorkspace } from "./components/PdfWorkspace";
import { RightPanel } from "./components/RightPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { DiscoverySidebar } from "./components/DiscoverySidebar";
import { DiscoveryLibrary } from "./components/DiscoveryLibrary";
import type { HomeMode } from "./components/HomeNavigation";
import { ReaderToolRail } from "./components/ReaderToolRail";
import { ExportDialog } from "./components/ExportDialog";
import { TranslationPane } from "./components/TranslationPane";
import { SelectionTranslationPopup, type SelectionTranslationPopupState } from "./components/SelectionTranslationPopup";
import { WritingWorkspace } from "./features/writer/WritingWorkspace";
import { WriterLibrary } from "./features/writer/WriterLibrary";
import { resolveWriterFile } from "./features/writer/services/local-writer";
import { loadAnnotations, saveAnnotations } from "./lib/annotations";
import { AI_FEATURE_PROMPTS, askAssistant, loadAiSettings, personalizedPrompt, saveAiSettings } from "./lib/ai";
import { emptyWorkspace, loadWorkspace, saveWorkspace } from "./lib/workspace";
import { openPdfFile, openPdfPath, pdfFileFromDrop } from "./lib/files";
import { addCitationToLibrary, loadLibrary, rememberDocument, removeFromLibrary, updateLibraryEntry, updateReadingPosition } from "./lib/library";
import { discoveryLibraryId, type DiscoveryPaper } from "./lib/discovery";
import type { DesktopPetContext } from "./lib/desktop-pet";
import { buildTextIndex, resolveOutline, searchTextIndex } from "./lib/pdf";
import type {
  AiSettings,
  Annotation,
  AnnotationRect,
  DocumentWorkspace,
  DocumentLibraryEntry,
  DesktopPetSettings,
  ImageCapture,
  LeftPanelTab,
  OutlineEntry,
  PdfDocumentState,
  PdfFile,
  RightPanelTab,
  ReaderMode,
  ReaderFeatureAction,
  QuizQuestion,
  SelectionAction,
  TextSelection,
  TranslationSegment,
} from "./types";
import "./styles.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function documentTitleFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
}

type TranslationTaskState = {
  status: "loading" | "error";
  message?: string;
};

type TextPart = { text: string; start: number; end: number };

function splitTranslationParts(value: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /[^.!?。！？\n]+[.!?。！？]?/g;
  for (const match of value.matchAll(pattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (!text || match.index === undefined) continue;
    const offset = raw.indexOf(text);
    parts.push({ text, start: match.index + offset, end: match.index + offset + text.length });
  }
  return parts.length ? parts : (value.trim() ? (() => {
    const text = value.trim();
    const start = value.indexOf(text);
    return [{ text, start, end: start + text.length }];
  })() : []);
}

function buildTranslationSegments(source: string, target: string): TranslationSegment[] {
  const sources = splitTranslationParts(source);
  const targets = splitTranslationParts(target);
  if (!sources.length || !targets.length) return [];
  return sources.map((part, index) => {
    const targetPart = targets[Math.min(index, targets.length - 1)];
    return {
      id: crypto.randomUUID(),
      sourceText: part.text,
      sourceRange: { start: part.start, end: part.end },
      targetText: targetPart.text,
      targetRange: { start: targetPart.start, end: targetPart.end },
    };
  });
}

async function inferDocumentTitle(proxy: PDFDocumentProxy): Promise<string | undefined> {
  try {
    const page = await proxy.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => {
      if (!("str" in item)) return [];
      const text = item.str.trim();
      if (!text || item.height <= 0) return [];
      return [{ text, height: item.height, x: item.transform[4], y: item.transform[5] }];
    });
    const titleCandidates = items.filter((item) => (
      !/^arxiv\s*:/i.test(item.text)
      && !/^https?:\/\//i.test(item.text)
      && !/^(?:copyright|provided proper attribution|preprint)/i.test(item.text)
    ));
    const maxHeight = Math.max(0, ...titleCandidates.map((item) => item.height));
    if (!maxHeight) return undefined;
    const titleLines = titleCandidates
      .filter((item) => item.height >= maxHeight * 0.92 && item.text.toLocaleLowerCase() !== "abstract")
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => item.text);
    const title = titleLines.join(" ").replace(/\s+/g, " ").trim();
    return title.length >= 8 && title.length <= 240 ? title : undefined;
  } catch {
    return undefined;
  }
}

function WhalePaperApp() {
  const [file, setFile] = useState<PdfFile | null>(null);
  const [document, setDocument] = useState<PdfDocumentState | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [textIndex, setTextIndex] = useState<string[]>([]);
  const [indexProgress, setIndexProgress] = useState(0);
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [targetPage, setTargetPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [discoveryOpen, setDiscoveryOpen] = useState(() => window.innerWidth >= 1320);
  const [leftTab, setLeftTab] = useState<LeftPanelTab>("thumbnails");
  const [rightTab, setRightTab] = useState<RightPanelTab>("assistant");
  const [selectedText, setSelectedText] = useState("");
  const [selectedTextContext, setSelectedTextContext] = useState({ before: "", after: "" });
  const [selectedTextRects, setSelectedTextRects] = useState<AnnotationRect[]>([]);
  const [selectedTextPage, setSelectedTextPage] = useState(1);
  const [readerMode, setReaderMode] = useState<ReaderMode>("select");
  const [imageCapture, setImageCapture] = useState<ImageCapture | null>(null);
  const [actionRequest, setActionRequest] = useState<ReaderFeatureAction | null>(null);
  const [citationTarget, setCitationTarget] = useState<number | null>(null);
  const [library, setLibrary] = useState<DocumentLibraryEntry[]>(loadLibrary);
  const [workspace, setWorkspace] = useState<DocumentWorkspace>(() => emptyWorkspace());
  const [quizEvidenceQuestionId, setQuizEvidenceQuestionId] = useState<string | null>(null);
  const [activeTranslationSegmentId, setActiveTranslationSegmentId] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => loadAiSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<"general" | "metadata" | "models" | "runtime" | "pet">("general");
  const [exportOpen, setExportOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [translationTasks, setTranslationTasks] = useState<Record<number, TranslationTaskState>>({});
  const [selectionTranslationPopup, setSelectionTranslationPopup] = useState<SelectionTranslationPopupState | null>(null);
  const [writerLocation, setWriterLocation] = useState<{ rootPath: string; initialFile?: string } | null>(null);
  const [homeMode, setHomeMode] = useState<HomeMode>("reader");
  const translationRequestsRef = useRef(new Map<number, string>());
  const translationSessionRef = useRef(0);
  const desktopPetEnabledRef = useRef(aiSettings.desktopPet.enabled);
  const desktopPetContextRef = useRef<DesktopPetContext>({ documentId: "", title: "", page: 1, pageText: "", selectedText: "" });

  const updateTranslationRects = useCallback((segmentId: string, rects: AnnotationRect[]) => {
    setWorkspace((current) => ({
      ...current,
      translations: current.translations.map((translation) => ({
        ...translation,
        segments: translation.segments?.map((segment) => segment.id === segmentId ? { ...segment, rects } : segment),
      })),
    }));
  }, []);

  // PDF.js transfers this buffer to its worker. Keep the original bytes intact for export and reload.
  const source = useMemo(() => (file ? { data: file.data.slice() } : null), [file]);
  const searchHits = useMemo(() => searchTextIndex(textIndex, query), [textIndex, query]);
  const visibleAnnotations = useMemo(() => annotations.filter((annotation) => (
    annotation.type !== "highlight" || workspace.preferences.highlightVisibility.manual[annotation.color]
  )), [annotations, workspace.preferences.highlightVisibility.manual]);
  const visibleAutoHighlights = useMemo(() => workspace.autoHighlights.filter((highlight) => (
    workspace.preferences.highlightVisibility.automatic
    && workspace.preferences.highlightVisibility.categories[highlight.category]
  )), [workspace.autoHighlights, workspace.preferences.highlightVisibility]);

  const loadFile = useCallback((nextFile: PdfFile) => {
    translationSessionRef.current += 1;
    translationRequestsRef.current.clear();
    setFile(nextFile);
    setDocument(null);
    setOutline([]);
    setTextIndex([]);
    setIndexProgress(0);
    setQuery("");
    setCurrentPage(1);
    setTargetPage(1);
    setZoom(1);
    setRotation(0);
    setSelectedText("");
    setSelectedTextContext({ before: "", after: "" });
    setSelectedTextRects([]);
    setSelectedTextPage(1);
    setReaderMode("select");
    setImageCapture(null);
    setActionRequest(null);
    setCitationTarget(null);
    setWorkspace(emptyWorkspace());
    setActiveTranslationSegmentId(null);
    setTranslationTasks({});
    setError("");
  }, []);

  const chooseFile = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextFile = await openPdfFile();
      if (nextFile) loadFile(nextFile);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "无法打开这个 PDF。请检查文件是否可读。");
    } finally {
      setLoading(false);
    }
  }, [loadFile]);

  const chooseWriterProject = useCallback(async () => {
    setError("");
    if (!window.__TAURI_INTERNALS__) {
      setError("论文写作项目需要在 WhalePaper 桌面版中打开。");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: false, directory: true });
      if (selected && !Array.isArray(selected)) {
        setFile(null);
        setDocument(null);
        setHomeMode("writer");
        setWriterLocation({ rootPath: selected });
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "无法打开写作项目目录。");
    }
  }, []);

  const chooseWriterFile = useCallback(async () => {
    setError("");
    if (!window.__TAURI_INTERNALS__) {
      setError("LaTeX 文档需要在 WhalePaper 桌面版中打开。");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "LaTeX 文档", extensions: ["tex"] }],
      });
      if (selected && !Array.isArray(selected)) {
        const location = await resolveWriterFile(selected);
        setFile(null);
        setDocument(null);
        setHomeMode("writer");
        setWriterLocation({ rootPath: location.rootPath, initialFile: location.relativePath });
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "无法打开 LaTeX 文档。");
    }
  }, []);

  const openLibraryEntry = useCallback(async (entry: DocumentLibraryEntry) => {
    if (!entry.sourcePath) {
      setError("这条历史来自浏览器上传，没有可重新读取的本地路径。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      loadFile(await openPdfPath(entry.sourcePath));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "无法从历史路径打开这篇论文。");
    } finally {
      setLoading(false);
    }
  }, [loadFile]);

  const handleDocumentLoad = useCallback(async (proxy: PDFDocumentProxy) => {
    if (!file) return;
    let title = file.displayTitle?.trim() || documentTitleFromFilename(file.name);
    let hasMetadataTitle = Boolean(file.displayTitle?.trim());
    let author = file.displayAuthor?.trim() || "";
    const nextMetadata: Pick<PdfDocumentState, "subject" | "keywords" | "year"> = {};
    try {
      const metadata = await proxy.getMetadata();
      const info = metadata.info as { Title?: string; Author?: string; Subject?: string; Keywords?: string; CreationDate?: string };
      const metadataTitle = info.Title?.trim();
      if (metadataTitle && !/^arxiv\s*:/i.test(metadataTitle) && !/^https?:\/\//i.test(metadataTitle)) {
        title = metadataTitle;
        hasMetadataTitle = true;
      }
      author = file.displayAuthor?.trim() || info.Author?.trim() || "";
      const yearMatch = info.CreationDate?.match(/(?:19|20)\d{2}/);
      Object.assign(nextMetadata, {
        subject: info.Subject?.trim() || undefined,
        keywords: info.Keywords?.split(/[,;]/).map((item) => item.trim()).filter(Boolean),
        year: yearMatch ? Number(yearMatch[0]) : undefined,
      });
    } catch {
      // Metadata is optional and malformed values should not block reading.
    }
    if (!hasMetadataTitle) title = await inferDocumentTitle(proxy) || title;
    const id = proxy.fingerprints[0] || `${file.name}:${proxy.numPages}`;
    const nextDocument = { id, file, proxy, title, author, pageCount: proxy.numPages, ...nextMetadata };
    const previous = loadLibrary().find((entry) => entry.id === id);
    const resumePage = Math.min(proxy.numPages, Math.max(1, previous?.lastPage || 1));
    setDocument(nextDocument);
    setCurrentPage(resumePage);
    setTargetPage(resumePage);
    setAnnotations(loadAnnotations(id));
    const nextWorkspace = loadWorkspace(id, { theme: aiSettings.appearance.documentTheme });
    setWorkspace(nextWorkspace);
    setZoom(nextWorkspace.preferences.zoom);
    setRotation(nextWorkspace.preferences.rotation);
    if (file.libraryMode !== "temporary") setLibrary(rememberDocument(nextDocument, resumePage));
  }, [aiSettings.appearance.documentTheme, file]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    setOutlineLoading(true);
    void resolveOutline(document.proxy)
      .then((items) => !cancelled && setOutline(items))
      .finally(() => !cancelled && setOutlineLoading(false));
    void buildTextIndex(document.proxy, (progress) => !cancelled && setIndexProgress(progress)).then((index) => {
      if (!cancelled) setTextIndex(index);
    });
    return () => { cancelled = true; };
  }, [document]);

  useEffect(() => {
    if (document) saveAnnotations(document.id, annotations);
  }, [annotations, document]);

  useEffect(() => {
    if (document) saveWorkspace(document.id, workspace);
  }, [document, workspace]);

  useEffect(() => {
    window.document.documentElement.dataset.reduceMotion = aiSettings.appearance.reduceMotion ? "true" : "false";
  }, [aiSettings.appearance.reduceMotion]);

  useEffect(() => {
    desktopPetEnabledRef.current = aiSettings.desktopPet.enabled;
  }, [aiSettings.desktopPet.enabled]);

  useEffect(() => {
    const nextContext = {
      documentId: document?.id || "",
      title: document?.title || "",
      page: currentPage,
      pageText: (textIndex[currentPage - 1] || "").slice(0, 12_000),
      selectedText: selectedText.slice(0, 4_000),
    };
    desktopPetContextRef.current = nextContext;
    if (window.__TAURI_INTERNALS__) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => (
        getCurrentWindow().emitTo("pet", "desktop-pet-context-response", nextContext)
      ));
    }
  }, [currentPage, document, selectedText, textIndex]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/window")]).then(async ([eventApi, windowApi]) => {
      const appWindow = windowApi.getCurrentWindow();
      const unlistenHomeMode = await eventApi.listen<HomeMode>("open-home-mode", (event) => {
        setFile(null);
        setDocument(null);
        setWriterLocation(null);
        setHomeMode(event.payload);
      });
      const unlistenPetSettings = await eventApi.listen("open-desktop-pet-settings", () => {
        setSettingsFocus("pet");
        setSettingsOpen(true);
      });
      const unlistenPetSettingsUpdated = await eventApi.listen<DesktopPetSettings>("desktop-pet-settings-updated", (event) => {
        setAiSettings((current) => {
          const next = { ...current, desktopPet: event.payload };
          saveAiSettings(next);
          return next;
        });
      });
      const unlistenPetContextRequest = await eventApi.listen("desktop-pet-context-request", () => {
        void appWindow.emitTo("pet", "desktop-pet-context-response", desktopPetContextRef.current);
      });
      const unlistenClose = await appWindow.onCloseRequested((event) => {
        event.preventDefault();
        if (desktopPetEnabledRef.current) void appWindow.hide();
        else void import("@tauri-apps/api/core").then(({ invoke }) => invoke("quit_app"));
      });
      if (disposed) {
        unlistenHomeMode();
        unlistenPetSettings();
        unlistenPetSettingsUpdated();
        unlistenPetContextRequest();
        unlistenClose();
      } else {
        cleanups = [unlistenHomeMode, unlistenPetSettings, unlistenPetSettingsUpdated, unlistenPetContextRequest, unlistenClose];
      }
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    if (document && document.file.libraryMode !== "temporary") setLibrary(updateReadingPosition(document.id, currentPage));
  }, [currentPage, document]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseFile();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && document) {
        event.preventDefault();
        setLeftOpen(true);
        setLeftTab("search");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseFile, document]);

  const navigate = useCallback((page: number) => {
    if (!document) return;
    const next = Math.min(document.pageCount, Math.max(1, page));
    setTargetPage(next);
    setCurrentPage(next);
  }, [document]);

  const translatePage = useCallback(async (pageNumber: number) => {
    if (!document || translationRequestsRef.current.has(pageNumber)) return;
    const sourceText = (textIndex[pageNumber - 1] || "").trim();
    if (!sourceText) {
      setTranslationTasks((current) => ({
        ...current,
        [pageNumber]: { status: "error", message: "当前页还没有可翻译文本，请等待 PDF 文本解析完成后重试。" },
      }));
      return;
    }

    const requestId = crypto.randomUUID();
    const session = translationSessionRef.current;
    translationRequestsRef.current.set(pageNumber, requestId);
    setTranslationTasks((current) => ({ ...current, [pageNumber]: { status: "loading" } }));
    try {
      const answer = await askAssistant(
        aiSettings,
        [{ id: crypto.randomUUID(), role: "user", content: personalizedPrompt(AI_FEATURE_PROMPTS.translation, aiSettings.prompts.translation) }],
        sourceText.slice(0, 16000),
        "translation",
      );
      if (session !== translationSessionRef.current || translationRequestsRef.current.get(pageNumber) !== requestId) return;
      setWorkspace((current) => ({
        ...current,
        translations: [
          ...current.translations.filter((item) => item.pageNumber !== pageNumber),
          { pageNumber, sourceLanguage: "auto", targetLanguage: "zh-CN", content: answer, segments: buildTranslationSegments(sourceText, answer), updatedAt: new Date().toISOString() },
        ],
      }));
      setTranslationTasks((current) => {
        const next = { ...current };
        delete next[pageNumber];
        return next;
      });
    } catch (translationError) {
      if (session !== translationSessionRef.current || translationRequestsRef.current.get(pageNumber) !== requestId) return;
      setTranslationTasks((current) => ({
        ...current,
        [pageNumber]: {
          status: "error",
          message: translationError instanceof Error ? translationError.message : "翻译请求失败。",
        },
      }));
    } finally {
      if (translationRequestsRef.current.get(pageNumber) === requestId) translationRequestsRef.current.delete(pageNumber);
    }
  }, [aiSettings, document, textIndex]);

  useEffect(() => {
    if (!document || !workspace.preferences.autoTranslateEnabled) return;
    if (workspace.translations.some((item) => item.pageNumber === currentPage)) return;
    if (!(textIndex[currentPage - 1] || "").trim()) return;
    const timer = window.setTimeout(() => void translatePage(currentPage), 220);
    return () => window.clearTimeout(timer);
  }, [currentPage, document, textIndex, translatePage, workspace.preferences.autoTranslateEnabled, workspace.translations]);

  useEffect(() => {
    if (!textIndex.length) return;
    setWorkspace((current) => {
      let changed = false;
      const translations = current.translations.map((translation) => {
        if (translation.segments?.length) return translation;
        const source = textIndex[translation.pageNumber - 1] || "";
        const segments = buildTranslationSegments(source, translation.content);
        if (!segments.length) return translation;
        changed = true;
        return { ...translation, segments };
      });
      return changed ? { ...current, translations } : current;
    });
  }, [textIndex]);

  const createAnnotation = (selection: TextSelection, type: "highlight" | "note", color: Annotation["color"]) => {
    if (!document) return;
    const timestamp = new Date().toISOString();
    setAnnotations((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        documentId: document.id,
        pageNumber: selection.pageNumber,
        type,
        color,
        quote: selection.quote,
        note: "",
        rects: selection.rects,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    if (type === "highlight") {
      setWorkspace((current) => ({
        ...current,
        preferences: {
          ...current.preferences,
          highlightVisibility: {
            ...current.preferences.highlightVisibility,
            manual: { ...current.preferences.highlightVisibility.manual, [color]: true },
          },
        },
      }));
    }
    if (type === "note") {
      setSelectedText(selection.quote);
      setRightOpen(true);
      setRightTab("notes");
    }
  };

  const handleSelectionAction = (action: SelectionAction, selection: TextSelection) => {
    setSelectedText(selection.quote);
    setSelectedTextContext({ before: selection.contextBefore, after: selection.contextAfter });
    setSelectedTextRects(selection.rects);
    setSelectedTextPage(selection.pageNumber);
    setRightOpen(true);
    if (action === "comment") {
      setRightTab("comments");
      return;
    }
    if (action === "ask-ai") {
      setRightTab("assistant");
      setActionRequest({ id: crypto.randomUUID(), type: "ask-selection" });
      return;
    }
    const requestId = crypto.randomUUID();
    if (action === "translate") {
      setSelectionTranslationPopup({
        id: requestId,
        x: selection.clientX,
        y: selection.clientY,
        source: selection.quote,
        status: "loading",
        response: "",
      });
    }
    setRightTab(action === "translate" ? "translation" : "explain");
    const type = action === "explain" ? "explain-selection" : "translate-selection";
    setActionRequest({ id: requestId, type, sourceType: selection.sourceType || "text" });
  };

  const updateAnnotation = (id: string, note: string) => {
    setAnnotations((current) => current.map((annotation) => (
      annotation.id === id ? { ...annotation, note, updatedAt: new Date().toISOString() } : annotation
    )));
  };

  const handleSettingsChange = (settings: AiSettings) => {
    desktopPetEnabledRef.current = settings.desktopPet.enabled;
    setAiSettings(settings);
    saveAiSettings(settings);
    if (window.__TAURI_INTERNALS__) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().emitTo("pet", "desktop-pet-settings-changed", settings.desktopPet));
    }
    if (document) {
      setWorkspace((current) => ({
        ...current,
        preferences: { ...current.preferences, theme: settings.appearance.documentTheme },
      }));
    }
  };

  const openSettings = (focus: "general" | "metadata" | "models" | "runtime" | "pet" = "general") => {
    setSettingsFocus(focus);
    setSettingsOpen(true);
  };

  const toggleDiscoveryPaper = (paper: DiscoveryPaper) => {
    const libraryId = discoveryLibraryId(paper);
    if (library.some((entry) => entry.id === libraryId)) {
      setLibrary(removeFromLibrary(libraryId));
      return;
    }
    setLibrary(addCitationToLibrary({
      id: `discovery-${paper.slug}`,
      paperId: paper.slug,
      documentId: document?.id || "",
      pageNumber: 1,
      quote: "",
      title: paper.title,
      authors: paper.authors.join(", "),
      formatted: paper.title,
      url: paper.url,
      openAccessPdf: paper.pdfUrl,
      abstract: paper.summary,
      source: paper.source,
      saved: true,
      createdAt: new Date().toISOString(),
    }));
  };

  const openDiscoveryPaper = async (paper: DiscoveryPaper) => {
    if (!paper.pdfUrl) throw new Error("这篇论文暂时没有可直接读取的 PDF。");
    const remoteFile = await openPdfPath(paper.pdfUrl);
    const safeTitle = paper.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) || "paper";
    loadFile({
      ...remoteFile,
      name: `${safeTitle}.pdf`,
      libraryMode: "temporary",
      displayTitle: paper.title,
      displayAuthor: paper.authors.join(", "),
    });
    setWriterLocation(null);
    setHomeMode("reader");
  };

  if (writerLocation) {
    return (
      <>
        <WritingWorkspace
          rootPath={writerLocation.rootPath}
          initialFile={writerLocation.initialFile}
          aiSettings={aiSettings}
          onClose={() => setWriterLocation(null)}
          onOpenFile={() => void chooseWriterFile()}
          onOpenProject={() => void chooseWriterProject()}
          onOpenSettings={(section) => openSettings(section || "models")}
        />
        <SettingsDialog open={settingsOpen} settings={aiSettings} focusSection={settingsFocus} onClose={() => setSettingsOpen(false)} onSave={handleSettingsChange} />
      </>
    );
  }

  if (!file || !source) {
    if (homeMode === "discovery") {
      return (
        <>
          <DiscoveryLibrary
            entries={library}
            onNavigate={setHomeMode}
            onToggleSavedPaper={toggleDiscoveryPaper}
            onOpenPaper={openDiscoveryPaper}
            onOpenSettings={() => openSettings()}
          />
          <SettingsDialog open={settingsOpen} settings={aiSettings} focusSection={settingsFocus} onClose={() => setSettingsOpen(false)} onSave={handleSettingsChange} />
        </>
      );
    }
    if (homeMode === "writer") {
      return (
        <>
          <WriterLibrary
            onNavigate={setHomeMode}
            onOpenProject={(project) => setWriterLocation({ rootPath: project.rootPath, initialFile: project.mainFile })}
            onAddProject={() => void chooseWriterProject()}
            onAddFile={() => void chooseWriterFile()}
            onOpenSettings={() => openSettings()}
          />
          <SettingsDialog open={settingsOpen} settings={aiSettings} focusSection={settingsFocus} onClose={() => setSettingsOpen(false)} onSave={handleSettingsChange} />
        </>
      );
    }
    return (
      <>
        <Welcome
          onOpen={() => void chooseFile()}
          onNavigate={setHomeMode}
          recentDocuments={library}
          onOpenRecent={(entry) => void openLibraryEntry(entry)}
          onOpenAnnotations={(entry) => { void openLibraryEntry(entry).then(() => setRightTab("highlights")); }}
          onRemoveRecent={(id) => setLibrary(removeFromLibrary(id))}
          onUpdateRecent={(id, patch) => setLibrary(updateLibraryEntry(id, patch))}
          onDropFile={(droppedFile) => void pdfFileFromDrop(droppedFile).then(loadFile)}
          onOpenSettings={() => openSettings()}
          loading={loading}
          error={error}
        />
        <SettingsDialog open={settingsOpen} settings={aiSettings} focusSection={settingsFocus} onClose={() => setSettingsOpen(false)} onSave={handleSettingsChange} />
      </>
    );
  }

  return (
    <main
      className={`app-shell theme-${workspace.preferences.theme}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const droppedFile = event.dataTransfer.files[0];
        if (droppedFile?.name.toLowerCase().endsWith(".pdf")) void pdfFileFromDrop(droppedFile).then(loadFile);
      }}
    >
      {discoveryOpen && document && (
        <DiscoverySidebar
          document={document}
          entries={library}
          semanticScholarApiKey={aiSettings.semanticScholarApiKey}
          onToggleSavedPaper={toggleDiscoveryPaper}
          onToggleCurrentFavorite={() => setLibrary(updateLibraryEntry(document.id, { favorite: !library.find((entry) => entry.id === document.id)?.favorite }))}
          onShowLibrary={() => { setFile(null); setDocument(null); }}
          onClose={() => setDiscoveryOpen(false)}
          theme={workspace.preferences.theme}
          onThemeChange={(theme) => setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, theme } }))}
          onOpenSettings={() => openSettings()}
        />
      )}
      <div className="reader-frame">
        <TopToolbar
          filename={document?.title || file.name}
          currentPage={currentPage}
          pageCount={document?.pageCount || 1}
          zoom={zoom}
          rotation={rotation}
          theme={workspace.preferences.theme}
          mode={readerMode}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          discoveryOpen={discoveryOpen}
          onToggleDiscovery={() => setDiscoveryOpen((value) => !value)}
          onToggleLeft={() => setLeftOpen((value) => !value)}
          onToggleRight={() => setRightOpen((value) => !value)}
          onOpen={() => void chooseFile()}
          onPageChange={navigate}
          onZoomChange={(value) => {
            setZoom(value);
            setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, zoom: value } }));
          }}
          onRotate={() => {
            const value = ((rotation + 90) % 360) as 0 | 90 | 180 | 270;
            setRotation(value);
            setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, rotation: value } }));
          }}
          onThemeChange={(theme) => setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, theme } }))}
          onModeChange={setReaderMode}
          onTranslatePage={() => {
            setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, translationViewOpen: true } }));
            void translatePage(currentPage);
          }}
          onAutoHighlight={() => { setRightTab("highlights"); setRightOpen(true); setActionRequest({ id: crypto.randomUUID(), type: "auto-highlight" }); }}
          onCaptureImage={() => setReaderMode("image")}
          onExport={() => setExportOpen(true)}
          onSearch={() => { setLeftOpen(true); setLeftTab("search"); }}
        />

        <Document
          className="reader-document"
          file={source}
          onLoadSuccess={(proxy) => void handleDocumentLoad(proxy)}
          onLoadError={(loadError) => setError(loadError.message)}
          loading={<div className="document-loading"><span /><p>正在解析 PDF...</p></div>}
          error={<div className="document-error"><h2>无法读取 PDF</h2><p>{error || "文件可能已损坏或受到密码保护。"}</p><button className="primary-button compact" type="button" onClick={() => void chooseFile()}>打开其他文件</button></div>}
        >
          {document && (
            <div className="reader-body">
            {leftOpen && (
              <LeftSidebar
                pdf={document.proxy}
                activeTab={leftTab}
                onTabChange={setLeftTab}
                currentPage={currentPage}
                pageCount={document.pageCount}
                outline={outline}
                outlineLoading={outlineLoading}
                query={query}
                onQueryChange={setQuery}
                searchHits={searchHits}
                indexProgress={indexProgress}
                onNavigate={navigate}
                onClose={() => setLeftOpen(false)}
              />
            )}
            <PdfWorkspace
              documentId={document.id}
              pdf={document.proxy}
              pageCount={document.pageCount}
              zoom={zoom}
              rotation={rotation}
              targetPage={targetPage}
              searchQuery={query}
              annotations={visibleAnnotations}
              comments={workspace.comments}
              autoHighlights={[
                ...visibleAutoHighlights,
                ...((workspace.quiz?.questions || []).flatMap((question) => question.id === quizEvidenceQuestionId && question.evidence.pageNumber > 0 ? [{
                  id: `quiz-evidence:${question.id}`,
                  documentId: document.id,
                  pageNumber: question.evidence.pageNumber,
                  quote: question.evidence.evidenceQuote,
                  explanation: "问答游戏原文依据",
                  category: "results" as const,
                  rects: question.evidence.rects,
                  createdAt: new Date().toISOString(),
                }] : [])),
              ]}
              showAutoHighlightLabels={workspace.preferences.highlightVisibility.labels}
              ink={workspace.ink}
              mode={readerMode}
              onModeChange={setReaderMode}
              onInkChange={(ink) => setWorkspace((current) => ({ ...current, ink }))}
              onAutoHighlightRectsChange={(id, rects) => setWorkspace((current) => id.startsWith("quiz-evidence:") && current.quiz ? {
                ...current,
                quiz: { ...current.quiz, questions: current.quiz.questions.map((question) => question.id === id.slice(14) && !question.evidence.rects?.length ? { ...question, evidence: { ...question.evidence, rects } } : question) },
              } : {
                ...current,
                autoHighlights: current.autoHighlights.map((item) => item.id === id && !item.rects?.length ? { ...item, rects } : item),
              })}
              onCitationSelect={(referenceNumber) => {
                setCitationTarget(referenceNumber);
                setRightTab("citations");
                setRightOpen(true);
              }}
              onImageCapture={(capture) => {
                setImageCapture(capture);
                setRightTab(capture.intent === "translate" ? "translation" : "explain");
                setRightOpen(true);
              }}
              onCurrentPageChange={setCurrentPage}
              onSelectionAction={handleSelectionAction}
              onCreateAnnotation={createAnnotation}
              onDeleteAnnotation={(id) => setAnnotations((current) => current.filter((annotation) => annotation.id !== id))}
              translations={workspace.translations}
              activeTranslationSegmentId={activeTranslationSegmentId}
              onTranslationSegmentActivate={(segment) => setActiveTranslationSegmentId(segment.id)}
              onTranslationRectsChange={updateTranslationRects}
            />
              {workspace.preferences.translationViewOpen && (
                <TranslationPane
                  currentPage={currentPage}
                  pageCount={document.pageCount}
                  translation={workspace.translations.find((item) => item.pageNumber === currentPage)}
                  fontSize={workspace.preferences.translationFontSize}
                  autoTranslateEnabled={workspace.preferences.autoTranslateEnabled}
                  loading={translationTasks[currentPage]?.status === "loading"}
                  error={translationTasks[currentPage]?.status === "error" ? translationTasks[currentPage]?.message : undefined}
                  onFontSizeChange={(translationFontSize) => setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, translationFontSize } }))}
                  onAutoTranslateChange={(autoTranslateEnabled) => setWorkspace((current) => ({
                    ...current,
                    preferences: { ...current.preferences, autoTranslateEnabled },
                  }))}
                  onRetranslate={() => void translatePage(currentPage)}
                  onDelete={() => {
                    translationRequestsRef.current.delete(currentPage);
                    setTranslationTasks((current) => {
                      const next = { ...current };
                      delete next[currentPage];
                      return next;
                    });
                    setWorkspace((current) => ({ ...current, translations: current.translations.filter((item) => item.pageNumber !== currentPage) }));
                  }}
                  onClose={() => setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, translationViewOpen: false } }))}
                  activeSegmentId={activeTranslationSegmentId}
                  onSegmentActivate={(segment, clicked) => {
                    setActiveTranslationSegmentId(segment.id);
                    if (clicked) setTargetPage(currentPage);
                  }}
                />
              )}
              {selectionTranslationPopup && (
                <SelectionTranslationPopup value={selectionTranslationPopup} onClose={() => setSelectionTranslationPopup(null)} />
              )}
              <div className={`reader-right-shell ${rightOpen ? "is-open" : ""}`}>
                {rightOpen && (
                  <RightPanel
                    document={document}
                    activeTab={rightTab}
                    onTabChange={setRightTab}
                    annotations={annotations}
                    workspace={workspace}
                    currentPage={currentPage}
                    currentPageText={textIndex[currentPage - 1] || ""}
                    textIndex={textIndex}
                    outline={outline}
                    selectedText={selectedText}
                    selectedTextContext={selectedTextContext}
                    selectedTextRects={selectedTextRects}
                    selectedTextPage={selectedTextPage}
                    imageCapture={imageCapture}
                    actionRequest={actionRequest}
                    citationTarget={citationTarget}
                    aiSettings={aiSettings}
                    libraryEntries={library}
                    onAiSettingsChange={(settings) => { setAiSettings(settings); saveAiSettings(settings); }}
                    onToggleCitationLibrary={(citation, inLibrary) => {
                      if (inLibrary) {
                        const entry = library.find((item) => item.title.trim().toLocaleLowerCase() === citation.title.trim().toLocaleLowerCase());
                        if (entry) setLibrary(removeFromLibrary(entry.id));
                      } else setLibrary(addCitationToLibrary(citation));
                    }}
                    onOpenSettings={(section) => openSettings(section || "general")}
                    onWorkspaceChange={setWorkspace}
                    onSelectionTranslationResult={(requestId, response, isError) => setSelectionTranslationPopup((current) => (
                      current?.id === requestId ? { ...current, status: isError ? "error" : "ready", response } : current
                    ))}
                    onUpdateAnnotation={updateAnnotation}
                    onDeleteAnnotation={(id) => setAnnotations((current) => current.filter((annotation) => annotation.id !== id))}
                    onClearSelection={() => { setSelectedText(""); setSelectedTextContext({ before: "", after: "" }); setSelectedTextRects([]); }}
                    onNavigate={navigate}
                    onQuizEvidence={(question: QuizQuestion) => { setQuizEvidenceQuestionId(question.id); navigate(question.evidence.pageNumber); }}
                    onClose={() => setRightOpen(false)}
                  />
                )}
                <ReaderToolRail
                  activeTab={rightTab}
                  panelOpen={rightOpen}
                  onSelect={(tab) => {
                    if (rightOpen && tab === rightTab) {
                      setRightOpen(false);
                      return;
                    }
                    setRightTab(tab);
                    setRightOpen(true);
                  }}
                  onToggle={() => setRightOpen((value) => !value)}
                />
              </div>
            </div>
          )}
        </Document>
      </div>

      <SettingsDialog
        open={settingsOpen}
        settings={aiSettings}
        focusSection={settingsFocus}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSettingsChange}
      />
      <ExportDialog open={exportOpen} document={document} annotations={annotations} workspace={workspace} onClose={() => setExportOpen(false)} />
    </main>
  );
}

export default function App() {
  return <WhalePaperApp />;
}
