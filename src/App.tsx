import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  UserProfile, 
  Category, 
  Folder,
  VideoLesson, 
  VideoCatalogEntry,
  PdfResource, 
  PaymentRequest, 
  PlatformSettings, 
  SalesRecord,
  AuditLog
} from './types';
import { 
  subscribeToAuth, 
  subscribeToCategories, 
  subscribeToFolders,
  subscribeToVideos, 
  subscribeToVideoCatalog,
  subscribeToPdfs, 
  subscribeToUsers, 
  subscribeToPaymentRequests, 
  subscribeToSettings, 
  subscribeToSales, 
  subscribeToAuditLogs,
  DEFAULT_SETTINGS,
  logoutUser,
  hasCourseAccess,
  UNWANTED_DEMO_VIDEO_IDS,
  UNWANTED_DEMO_PDF_IDS
} from './services/firebase';
import { seedEditingSuites } from './services/seed';
import { ToastProvider, useToast } from './components/Toast';
import { Navbar } from './components/Navbar';
import { SubscribeModal } from './components/SubscribeModal';
import { AuthModal } from './components/AuthModal';
import { VideoPlayerModal } from './components/VideoPlayerModal';
import { VideoDetailsModal } from './components/VideoDetailsModal';
import { PdfViewerModal } from './components/PdfViewerModal';
import { SkillFlixAiAssistant } from './components/SkillFlixAiAssistant';
import { HomeView } from './views/HomeView';
import { CategoryDetailView } from './views/CategoryDetailView';
import { VideosView } from './views/VideosView';
import { PdfsView } from './views/PdfsView';
import { ProfileView } from './views/ProfileView';
import { AdminView } from './views/AdminView';

function AppContent() {
  const { showToast } = useToast();

  // Core application data states
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [videos, setVideos] = useState<VideoLesson[]>([]);
  const [videoCatalog, setVideoCatalog] = useState<VideoCatalogEntry[]>([]);
  const [pdfs, setPdfs] = useState<PdfResource[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersRetryKey, setUsersRetryKey] = useState(0);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [settings, setSettings] = useState<PlatformSettings>(DEFAULT_SETTINGS);
  const [sales, setSales] = useState<SalesRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  // Navigation & UI state
  const [currentView, setCurrentView] = useState<string>('home');
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals state
  const [isSubscribeOpen, setIsSubscribeOpen] = useState(false);
  const [subscribeCategoryTarget, setSubscribeCategoryTarget] = useState<Category | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<VideoLesson | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoLesson | null>(null);
  const [viewingPdf, setViewingPdf] = useState<PdfResource | null>(null);

  const lastAuthUidRef = useRef<string | null | undefined>(undefined);

  // Subscribe to real-time Firebase / persistence data
  useEffect(() => {
    const unsubAuth = subscribeToAuth((user) => {
      const nextUid = user?.uid ?? null;
      const authChanged = lastAuthUidRef.current !== nextUid;
      lastAuthUidRef.current = nextUid;
      setCurrentUser(user);
      if (authChanged) {
        setCurrentView(user?.role === 'admin' || user?.role === 'master_admin' ? 'admin' : 'home');
      } else if (!user) {
        setCurrentView((prev) => (prev === 'admin' ? 'home' : prev));
      }
      setAuthReady(true);
    });

    return () => {
      unsubAuth();
    };
  }, []);

  // Public category listing is available before login.
  // Private content and account data remain restricted to signed-in users.
  useEffect(() => {
    const unsubCats = subscribeToCategories((cats) => setCategories(cats));
    const unsubCatalog = subscribeToVideoCatalog((entries) => setVideoCatalog(entries));

    if (!currentUser?.uid) {
      setFolders([]);
      setVideos([]);
      setPdfs([]);
      setPaymentRequests([]);
      setSales([]);
      setAuditLogs([]);
      setSettings(DEFAULT_SETTINGS);

      return () => {
        unsubCats();
        unsubCatalog();
      };
    }

    const unsubFolders = subscribeToFolders((flds) => setFolders(flds));
    const unsubSettings = subscribeToSettings((s) => setSettings(s));
    const unsubSales = subscribeToSales((sl) => setSales(sl));
    const unsubAudit = subscribeToAuditLogs((logs) => setAuditLogs(logs));
    const unsubPayments = subscribeToPaymentRequests(setPaymentRequests);
    const canViewDrafts =
      currentUser.role === 'admin' || currentUser.role === 'master_admin';
    const unsubVideos = subscribeToVideos(setVideos, canViewDrafts);
    const unsubPdfs = subscribeToPdfs(setPdfs, canViewDrafts);

    return () => {
      unsubCats();
      unsubCatalog();
      unsubFolders();
      unsubSettings();
      unsubSales();
      unsubAudit();
      unsubPayments();
      unsubVideos();
      unsubPdfs();
    };
  }, [
    currentUser?.uid,
    currentUser?.role,
    currentUser?.hasAllAccess,
    JSON.stringify(currentUser?.allowedCategories || []),
    JSON.stringify(currentUser?.assignedCourses || []),
    currentUser?.accessExpiry,
    currentUser?.subscriptionStatus,
    currentUser?.isSuspended,
    currentUser?.accountStatus
  ]);

  // Real-time users directory subscription for admins/owner (decoupled from student entitlement fields)
  useEffect(() => {
    const isAdminActor =
      Boolean(currentUser?.uid) &&
      (currentUser?.isPlatformOwner === true ||
        currentUser?.role === 'admin' ||
        currentUser?.role === 'master_admin') &&
      currentUser?.isSuspended !== true;

    if (!isAdminActor) {
      setUsers([]);
      setUsersLoading(false);
      setUsersError(null);
      return;
    }

    const unsubUsers = subscribeToUsers(setUsers, {
      actorUser: currentUser,
      onStatus: ({ loading, error }) => {
        setUsersLoading(loading);
        setUsersError(error);
      }
    });

    return () => {
      unsubUsers();
    };
  }, [
    currentUser?.uid,
    currentUser?.role,
    currentUser?.isSuspended,
    currentUser?.isPlatformOwner,
    usersRetryKey
  ]);

  // Signed-out visitors (and students without an entitlement) still see the
  // lesson list and its count. Those rows come from the public catalog and
  // carry no playable URL, so playing always requires granted access.
  const visibleVideos = useMemo<VideoLesson[]>(() => {
    const merged = new Map<string, VideoLesson>();

    videoCatalog.forEach((entry) => {
      if (!entry.isPublished || UNWANTED_DEMO_VIDEO_IDS.has(entry.id)) return;
      merged.set(entry.id, {
        id: entry.id,
        title: entry.title,
        description: entry.description || '',
        categoryId: entry.categoryId,
        categoryName: entry.categoryName || '',
        folderId: entry.folderId,
        folderName: entry.folderName || '',
        episode: entry.episode || '',
        videoUrl: '',
        thumbnailUrl: entry.thumbnailUrl || '',
        duration: entry.duration || '',
        isPublished: true,
        isFreePreview: entry.isFreePreview === true,
        order: entry.order,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        isCatalogOnly: true
      });
    });

    // A lesson the viewer is entitled to replaces its catalog row, adding the URL.
    videos.forEach((video) => {
      if (UNWANTED_DEMO_VIDEO_IDS.has(video.id)) return;
      merged.set(video.id, video);
    });

    const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master_admin';
    return Array.from(merged.values())
      .filter((video) => !UNWANTED_DEMO_VIDEO_IDS.has(video.id) && (isAdmin || video.isPublished))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [videos, videoCatalog, currentUser?.role]);

  const visiblePdfs = useMemo<PdfResource[]>(() => {
    return pdfs.filter((p) => !UNWANTED_DEMO_PDF_IDS.has(p.id));
  }, [pdfs]);

  const handleOpenSubscribe = (cat?: Category) => {
    setSubscribeCategoryTarget(cat || null);
    setIsSubscribeOpen(true);
  };

  const handleSelectCategory = (cat: Category) => {
    setSelectedCategory(cat);
    setCurrentView('category-detail');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSeedDefaults = async () => {
    try {
      showToast('Seeding Alight Motion, CapCut, Premiere Pro, and After Effects suites...', 'info');
      await seedEditingSuites();
      showToast('Successfully initialized 4 course suites with structured subfolders and lessons!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to seed categories.', 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
      showToast('Logged out successfully', 'info');
    } catch (e: any) {
      showToast('Failed to log out', 'error');
    }
  };

  const hasAccessToCategory = (catId?: string): boolean => {
    if (!catId) return hasCourseAccess(currentUser);
    return hasCourseAccess(currentUser, catId);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#05070D] flex items-center justify-center" role="status" aria-label="Loading account">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#05070D] text-slate-100 flex flex-col font-['Plus_Jakarta_Sans']">
      
      {/* Top Navbar & Mobile Bottom Bar */}
      <Navbar
        currentView={currentView}
        onNavigate={(view) => {
          setCurrentView(view);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        currentUser={currentUser}
        settings={settings}
        onOpenAuth={() => setIsAuthOpen(true)}
        onOpenSubscribe={() => handleOpenSubscribe()}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 pb-24 sm:pb-12">
        {currentView === 'home' && (
          <HomeView
            categories={categories}
            folders={folders}
            videos={visibleVideos}
            currentUser={currentUser}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectCategory={handleSelectCategory}
            onOpenSubscribe={handleOpenSubscribe}
            onNavigate={setCurrentView}
            onSeedCategories={handleSeedDefaults}
          />
        )}

        {currentView === 'category-detail' && selectedCategory && (
          <CategoryDetailView
            category={categories.find(c => c.id === selectedCategory.id) || selectedCategory}
            folders={folders}
            videos={visibleVideos}
            pdfs={visiblePdfs}
            currentUser={currentUser}
            onBack={() => setCurrentView('home')}
            onPlayVideo={(v) => setPlayingVideo(v)}
            onPreviewVideo={(v) => setPreviewVideo(v)}
            onViewPdf={(p) => setViewingPdf(p)}
            onOpenSubscribe={handleOpenSubscribe}
          />
        )}

        {currentView === 'videos' && (
          <VideosView
            videos={visibleVideos}
            categories={categories}
            currentUser={currentUser}
            searchQuery={searchQuery}
            onPlayVideo={(v) => setPlayingVideo(v)}
            onPreviewVideo={(v) => setPreviewVideo(v)}
            onOpenSubscribe={handleOpenSubscribe}
          />
        )}

        {currentView === 'pdfs' && (
          <PdfsView
            pdfs={visiblePdfs}
            categories={categories}
            currentUser={currentUser}
            searchQuery={searchQuery}
            onViewPdf={(p) => setViewingPdf(p)}
            onOpenSubscribe={handleOpenSubscribe}
          />
        )}

        {currentView === 'profile' && (
          <ProfileView
            currentUser={currentUser}
            categories={categories}
            videos={visibleVideos}
            paymentRequests={paymentRequests}
            settings={settings}
            onOpenSubscribe={() => handleOpenSubscribe()}
            onOpenAuth={() => setIsAuthOpen(true)}
            onNavigate={setCurrentView}
          />
        )}

        {currentView === 'admin' && (
          <AdminView
            currentUser={currentUser}
            categories={categories}
            folders={folders}
            videos={visibleVideos}
            pdfs={visiblePdfs}
            users={users}
            usersLoading={usersLoading}
            usersError={usersError}
            onRetryUsersSync={() => setUsersRetryKey((k) => k + 1)}
            paymentRequests={paymentRequests}
            settings={settings}
            sales={sales}
            auditLogs={auditLogs}
            onNavigate={setCurrentView}
            onSeedDefaults={handleSeedDefaults}
          />
        )}
      </main>

      {/* Skill-Flix AI Floating Learning Assistant */}
      {currentView !== 'admin' && (
        <SkillFlixAiAssistant
          currentUser={currentUser}
          onOpenAuth={() => setIsAuthOpen(true)}
        />
      )}

      {/* Modals */}
      <SubscribeModal
        isOpen={isSubscribeOpen}
        onClose={() => setIsSubscribeOpen(false)}
        currentUser={currentUser}
        selectedCategory={subscribeCategoryTarget}
        settings={settings}
        existingRequests={paymentRequests}
        onOpenAuth={() => {
          setIsSubscribeOpen(false);
          setIsAuthOpen(true);
        }}
      />

      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onSuccess={() => {
          setIsAuthOpen(false);
        }}
      />

      <VideoPlayerModal
        isOpen={!!playingVideo}
        onClose={() => setPlayingVideo(null)}
        video={playingVideo}
        allLessons={videos}
        onSelectVideo={(v) => setPlayingVideo(v)}
      />

      <VideoDetailsModal
        video={previewVideo}
        category={previewVideo ? categories.find(c => c.id === previewVideo.categoryId) || null : null}
        isSignedIn={!!currentUser?.uid}
        isUnlocked={previewVideo ? hasAccessToCategory(previewVideo.categoryId) : false}
        onClose={() => setPreviewVideo(null)}
        onUnlock={() => {
          const target = previewVideo ? categories.find(c => c.id === previewVideo.categoryId) || null : null;
          setPreviewVideo(null);
          handleOpenSubscribe(target || undefined);
        }}
        onSignIn={() => {
          setPreviewVideo(null);
          setIsAuthOpen(true);
        }}
      />

      <PdfViewerModal
        isOpen={!!viewingPdf}
        onClose={() => setViewingPdf(null)}
        pdf={viewingPdf}
        settings={settings}
        hasAccess={viewingPdf ? hasAccessToCategory(viewingPdf.categoryId) : false}
        onOpenSubscribe={() => {
          setViewingPdf(null);
          handleOpenSubscribe(categories.find(c => c.id === viewingPdf?.categoryId));
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
