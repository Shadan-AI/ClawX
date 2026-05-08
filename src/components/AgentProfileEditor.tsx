import { useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Eye, Edit3, Save, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const MD_FILES = [
  { id: 'AGENTS.md', label: 'AGENTS' },
  { id: 'SOUL.md', label: 'SOUL' },
  { id: 'TOOLS.md', label: 'TOOLS' },
  { id: 'IDENTITY.md', label: 'IDENTITY' },
  { id: 'USER.md', label: 'USER' },
  { id: 'HEARTBEAT.md', label: 'HEARTBEAT' },
];

interface AgentProfileEditorProps {
  agentId: string;
  className?: string;
}

export function AgentProfileEditor({ agentId, className }: AgentProfileEditorProps) {
  const [selectedFile, setSelectedFile] = useState(MD_FILES[0].id);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isPreview, setIsPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewHtml, setPreviewHtml] = useState({ __html: '' });

  useEffect(() => {
    loadFile(selectedFile);
  }, [agentId, selectedFile]);

  useEffect(() => {
    if (isPreview) {
      renderPreview().then(setPreviewHtml);
    }
  }, [isPreview, content]);

  const loadFile = async (filename: string) => {
    setLoading(true);
    try {
      const result = await window.electron.ipcRenderer.invoke('agent-profile:read', {
        agentId,
        filename,
      }) as { success: boolean; content?: string; error?: string };
      
      if (result.success) {
        setContent(result.content || '');
        setOriginalContent(result.content || '');
      } else {
        toast.error(`加载失败: ${result.error}`);
      }
    } catch (error) {
      toast.error(`加载失败: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await window.electron.ipcRenderer.invoke('agent-profile:save', {
        agentId,
        filename: selectedFile,
        content,
      }) as { success: boolean; error?: string };
      
      if (result.success) {
        setOriginalContent(content);
        toast.success('保存成功');
      } else {
        toast.error(`保存失败: ${result.error}`);
      }
    } catch (error) {
      toast.error(`保存失败: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setContent(originalContent);
    toast.info('已重置');
  };

  const hasChanges = content !== originalContent;

  const renderPreview = async () => {
    const html = await marked(content);
    const sanitized = DOMPurify.sanitize(html);
    return { __html: sanitized };
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center gap-1 mb-3 border-b border-border pb-2">
        {MD_FILES.map((file) => (
          <button
            key={file.id}
            onClick={() => setSelectedFile(file.id)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded transition-colors',
              selectedFile === file.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-muted/80 text-muted-foreground'
            )}
          >
            {file.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Button
            variant={isPreview ? 'outline' : 'default'}
            size="sm"
            onClick={() => setIsPreview(false)}
            className="h-8 text-xs"
          >
            <Edit3 className="h-3 w-3 mr-1" />
            编辑
          </Button>
          <Button
            variant={isPreview ? 'default' : 'outline'}
            size="sm"
            onClick={() => setIsPreview(true)}
            className="h-8 text-xs"
          >
            <Eye className="h-3 w-3 mr-1" />
            预览
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={saving}
              className="h-8 text-xs"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              重置
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="h-8 text-xs"
          >
            <Save className="h-3 w-3 mr-1" />
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>

      <div className="flex-1 border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">加载中...</div>
          </div>
        ) : isPreview ? (
          <div
            className="prose prose-sm max-w-none p-4 overflow-auto h-full"
            dangerouslySetInnerHTML={previewHtml}
          />
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full p-4 bg-background text-foreground font-mono text-sm resize-none focus:outline-none"
            placeholder="在此编辑 Markdown 内容..."
          />
        )}
      </div>
    </div>
  );
}
