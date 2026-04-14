/**
 * First-run gate: native WeChat QR login.
 * Calls the main process directly — no Gateway dependency.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSettingsStore } from '@/stores/settings';
import { invokeIpc } from '@/lib/api-client';

interface QrScene { ticket: string; sceneId: string }

type ScanStatus = 'idle' | 'scanning' | 'scanned' | 'success' | 'expired' | 'need_phone' | 'need_register';

export function BoxImGate() {
  const { t } = useTranslation('boxImGate');
  const navigate = useNavigate();
  const markBoxImGateComplete = useSettingsStore((s) => s.markBoxImGateComplete);
  const boxImGateComplete = useSettingsStore((s) => s.boxImGateComplete);

  const [qrScene, setQrScene] = useState<QrScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [nickname, setNickname] = useState<string | null>(null);
  const [pendingOpenid, setPendingOpenid] = useState<string | null>(null);
  const [pendingNickname, setPendingNickname] = useState<string | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsLoading, setSmsLoading] = useState(false);
  const [bindLoading, setBindLoading] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  // Registration form fields (need_register flow)
  const [regUserName, setRegUserName] = useState('');
  const [regNickName, setRegNickName] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);

  // Check if already logged in on mount
  useEffect(() => {
    invokeIpc<string | null>('box-im:getTokenKey').then((tk) => {
      if (tk && boxImGateComplete) navigate('/', { replace: true });
    }).catch(() => {});
  }, [boxImGateComplete, navigate]);

  const fetchQrCode = useCallback(async () => {
    setLoading(true);
    setError(null);
    setQrScene(null);
    setStatus('idle');
    setNickname(null);
    // Reset all form state so re-scan starts clean
    setPhone('');
    setSmsCode('');
    setSmsError(null);
    setCountdown(0);
    setPendingOpenid(null);
    setPendingNickname(null);
    setPendingAvatar(null);
    setRegUserName('');
    setRegNickName('');
    setRegPassword('');
    setRegConfirmPassword('');
    attemptsRef.current = 0;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    try {
      const res = await invokeIpc<{ success: boolean; ticket?: string; sceneId?: string; error?: string }>(
        'wx-auth:createScene',
      );
      if (!res.success || !res.ticket || !res.sceneId) {
        throw new Error(res.error || '获取二维码失败');
      }
      setQrScene({ ticket: res.ticket, sceneId: res.sceneId });
      setStatus('scanning');
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取二维码失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch QR code immediately on mount
  useEffect(() => {
    void fetchQrCode();
  }, [fetchQrCode]);

  const handleLoginSuccess = useCallback(async (tokenKey: string, nick?: string | null, openid?: string, avatar?: string, accessToken?: string, userId?: number) => {
    await invokeIpc('wx-auth:persistLogin', tokenKey, userId, openid, nick ?? undefined, avatar, accessToken);
    setStatus('success');
    setNickname(nick ?? null);
    setTimeout(() => {
      markBoxImGateComplete();
      window.location.reload();
    }, 1500);
  }, [markBoxImGateComplete]);

  const pollScanResult = useCallback(async (sceneId: string) => {
    try {
      const res = await invokeIpc<{
        success: boolean;
        status?: string;
        openid?: string;
        nickname?: string;
        avatar?: string;
        error?: string;
      }>('wx-auth:pollScan', sceneId);

      if (!res.success) return;

      if (res.status === 'ok' && res.openid) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

        // Find or create IM user
        const userRes = await invokeIpc<{
          success: boolean;
          needPhone?: boolean;
          isNewUser?: boolean;
          tokenKey?: string;
          userId?: number;
          openid?: string;
          nickname?: string;
          avatar?: string;
          error?: string;
        }>('wx-auth:findOrCreateUser', res.openid, res.nickname, res.avatar);

        if (!userRes.success) {
          setError(userRes.error || '登录失败');
          return;
        }

        if (userRes.needPhone) {
          setPendingOpenid(userRes.openid ?? res.openid);
          setPendingNickname(userRes.nickname ?? res.nickname ?? null);
          setPendingAvatar(userRes.avatar ?? res.avatar ?? null);
          if (userRes.isNewUser) {
            // Brand-new user — show full registration form
            setRegNickName(userRes.nickname ?? res.nickname ?? '');
            setStatus('need_register');
          } else {
            // Existing account without phone — just bind phone
            setStatus('need_phone');
          }
        } else if (userRes.tokenKey) {
          await handleLoginSuccess(userRes.tokenKey, res.nickname, res.openid, res.avatar, undefined, userRes.userId);
        }
      } else if (res.status === 'scanned') {
        setStatus('scanned');
        if (res.nickname) setNickname(res.nickname);
      }
    } catch {
      // ignore polling errors
    }
  }, [handleLoginSuccess]);

  // Start polling once QR is shown
  useEffect(() => {
    if ((status !== 'scanning' && status !== 'scanned') || !qrScene) return;
    if (pollRef.current) return;

    pollRef.current = setInterval(() => {
      attemptsRef.current++;
      if (attemptsRef.current > 150) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setStatus('expired');
        return;
      }
      void pollScanResult(qrScene.sceneId);
    }, 2000);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [status, qrScene, pollScanResult]);

  // Listen for refresh signal from main process
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    const unsub = ipc.on('box-im:refresh', () => { void fetchQrCode(); });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [fetchQrCode]);

  const startCountdown = () => {
    setCountdown(60);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(countdownRef.current!); countdownRef.current = null; return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const handleSendSms = async () => {
    if (!/^1[3-9]\d{9}$/.test(phone)) { setSmsError('请输入正确的手机号格式'); return; }
    setSmsLoading(true);
    setSmsError(null);
    try {
      const res = await invokeIpc<{ success: boolean; error?: string }>('wx-auth:sendSms', phone);
      if (!res.success) throw new Error(res.error || '发送失败');
      startCountdown();
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : '验证码发送失败');
    } finally {
      setSmsLoading(false);
    }
  };

  const handleBindPhone = async () => {
    if (!phone || !smsCode || !pendingOpenid) return;
    setBindLoading(true);
    setSmsError(null);
    try {
      const res = await invokeIpc<{ success: boolean; tokenKey?: string; userId?: number; nickname?: string; error?: string }>(
        'wx-auth:bindPhone',
        pendingOpenid,
        phone,
        smsCode,
        pendingNickname ?? undefined,
        pendingAvatar ?? undefined,
      );
      if (!res.success) throw new Error(res.error || '绑定失败');
      if (res.tokenKey) await handleLoginSuccess(res.tokenKey, res.nickname ?? pendingNickname, pendingOpenid ?? undefined, pendingAvatar ?? undefined, undefined, res.userId);
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : '绑定失败，请重试');
    } finally {
      setBindLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!regUserName.trim()) { setSmsError('请输入用户名'); return; }
    if (!regNickName.trim()) { setSmsError('请输入昵称'); return; }
    if (regPassword.length < 5) { setSmsError('密码长度至少5位'); return; }
    if (regPassword !== regConfirmPassword) { setSmsError('两次密码输入不一致'); return; }
    if (!/^1[3-9]\d{9}$/.test(phone)) { setSmsError('请输入正确的手机号格式'); return; }
    if (!smsCode) { setSmsError('请输入验证码'); return; }
    if (!pendingOpenid) return;
    setRegLoading(true);
    setSmsError(null);
    try {
      const res = await invokeIpc<{ success: boolean; tokenKey?: string; userId?: number; accessToken?: string; error?: string }>(
        'wx-auth:register',
        pendingOpenid,
        regUserName.trim(),
        regNickName.trim(),
        regPassword,
        phone,
        smsCode,
        pendingAvatar ?? undefined,
      );
      if (!res.success) throw new Error(res.error || '注册失败');
      if (res.tokenKey) await handleLoginSuccess(res.tokenKey, regNickName, pendingOpenid, pendingAvatar ?? undefined, res.accessToken, res.userId);
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setRegLoading(false);
    }
  };

  const handleSkip = () => {
    markBoxImGateComplete();
    navigate('/setup', { replace: true });
  };

  const renderContent = () => {
    if (loading) {
      return (
        <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex justify-center"><Loader2 className="h-12 w-12 animate-spin text-primary" /></div>
          <p className="text-muted-foreground">{t('fetchingQrCode')}</p>
        </motion.div>
      );
    }

    if (error) {
      return (
        <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex items-center justify-center text-red-400"><XCircle className="h-12 w-12" /></div>
          <h2 className="text-xl font-semibold">{t('error')}</h2>
          <p className="text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => void fetchQrCode()}>
            <RefreshCw className="h-4 w-4 mr-2" />{t('retry')}
          </Button>
        </motion.div>
      );
    }

    if (status === 'scanning' && qrScene) {
      return (
        <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="bg-white p-4 rounded-xl shadow-lg">
              <img
                src={`https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(qrScene.ticket)}`}
                alt={t('wechatQrCode')}
                className="w-48 h-48 rounded-lg"
              />
            </div>
          </div>
          <p className="text-muted-foreground">{t('scanToLogin')}</p>
          <div className="flex flex-col items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void fetchQrCode()}>
              <RefreshCw className="h-4 w-4 mr-2" />{t('refreshQrCode')}
            </Button>
          </div>
        </motion.div>
      );
    }

    if (status === 'scanned') {
      return (
        <motion.div key="scanned" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="relative">
              <CheckCircle2 className="h-14 w-14 text-green-400" />
              <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-primary bg-background rounded-full" />
            </div>
          </div>
          <h2 className="text-xl font-semibold">扫码成功</h2>
          {nickname && <p className="text-muted-foreground text-sm">你好，{nickname}</p>}
          <p className="text-muted-foreground text-sm">请在手机上确认登录...</p>
        </motion.div>
      );
    }

    if (status === 'success') {
      return (
        <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex items-center justify-center text-green-400"><CheckCircle2 className="h-16 w-16" /></div>
          <h2 className="text-xl font-semibold">{t('loginSuccess')}</h2>
          {nickname && <p className="text-muted-foreground">{t('welcome', { nickname })}</p>}
          <p className="text-sm text-muted-foreground">{t('redirecting')}</p>
        </motion.div>
      );
    }

    if (status === 'expired') {
      return (
        <motion.div key="expired" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center space-y-4">
          <div className="flex items-center justify-center text-yellow-400"><XCircle className="h-12 w-12" /></div>
          <h2 className="text-xl font-semibold">{t('qrCodeExpired')}</h2>
          <Button variant="outline" onClick={() => void fetchQrCode()}>
            <RefreshCw className="h-4 w-4 mr-2" />{t('refreshQrCode')}
          </Button>
        </motion.div>
      );
    }

    if (status === 'need_phone') {
      return (
        <motion.div key="need_phone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
          <div className="text-center">
            <h2 className="text-xl font-semibold mb-1">绑定手机号</h2>
            <p className="text-muted-foreground text-sm">首次登录，请绑定手机号完成注册</p>
          </div>
          <div className="space-y-3">
            <Input placeholder="请输入手机号" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={11} />
            <div className="flex gap-2">
              <Input placeholder="请输入验证码" value={smsCode} onChange={(e) => setSmsCode(e.target.value)} maxLength={6} className="flex-1" />
              <Button variant="outline" onClick={() => void handleSendSms()} disabled={smsLoading || countdown > 0} className="shrink-0 min-w-[100px]">
                {smsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : countdown > 0 ? `${countdown}s后重发` : '发送验证码'}
              </Button>
            </div>
            {smsError && <p className="text-sm text-red-400">{smsError}</p>}
            <Button className="w-full" onClick={() => void handleBindPhone()} disabled={bindLoading || !phone || !smsCode}>
              {bindLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}确认绑定
            </Button>
            <Button variant="ghost" size="sm" className="w-full" onClick={() => void fetchQrCode()}>重新扫码</Button>
          </div>
        </motion.div>
      );
    }

    if (status === 'need_register') {
      return (
        <motion.div key="need_register" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
          <div className="text-center">
            <h2 className="text-xl font-semibold mb-1">注册账号</h2>
            <p className="text-muted-foreground text-sm">扫码成功，完善信息完成注册</p>
          </div>
          <div className="space-y-3">
            <Input
              placeholder="用户名（登录使用）"
              value={regUserName}
              onChange={(e) => setRegUserName(e.target.value)}
              maxLength={64}
            />
            <Input
              placeholder="昵称"
              value={regNickName}
              onChange={(e) => setRegNickName(e.target.value)}
              maxLength={64}
            />
            <Input
              type="password"
              placeholder="密码（至少5位）"
              value={regPassword}
              onChange={(e) => setRegPassword(e.target.value)}
              maxLength={20}
            />
            <Input
              type="password"
              placeholder="确认密码"
              value={regConfirmPassword}
              onChange={(e) => setRegConfirmPassword(e.target.value)}
              maxLength={20}
            />
            <Input
              placeholder="手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={11}
            />
            <div className="flex gap-2">
              <Input
                placeholder="验证码"
                value={smsCode}
                onChange={(e) => setSmsCode(e.target.value)}
                maxLength={6}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={() => void handleSendSms()}
                disabled={smsLoading || countdown > 0}
                className="shrink-0 min-w-[100px]"
              >
                {smsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : countdown > 0 ? `${countdown}s后重发` : '发送验证码'}
              </Button>
            </div>
            {smsError && <p className="text-sm text-red-400">{smsError}</p>}
            <Button
              className="w-full"
              onClick={() => void handleRegister()}
              disabled={regLoading}
            >
              {regLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}注册
            </Button>
            <Button variant="ghost" size="sm" className="w-full" onClick={() => void fetchQrCode()}>重新扫码</Button>
          </div>
        </motion.div>
      );
    }

    return null;
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-md p-8 pt-16">
          {status !== 'need_register' && (
            <div className="text-center mb-8">
              <h1 className="text-2xl font-semibold mb-2">{t('title')}</h1>
              <p className="text-muted-foreground">{t('subtitle')}</p>
            </div>
          )}
          <AnimatePresence mode="wait">
            {renderContent()}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default BoxImGate;
