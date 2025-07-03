import React, { useState, useEffect, useCallback } from 'react';
import ChatHeader from '../components/chat/ChatHeader';
import ChatMessages from '../components/chat/ChatMessages';
import ChatInput from '../components/chat/ChatInput';
import { Message, Category, ChatMode, AITeacher } from '../types';
import { firebaseChatService } from '../services/firebaseChatService';
import { firebaseAITeacherService } from '../services/firebaseAITeacherService';
import { aiChatService } from '../services/aiChatService';

const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [category, setCategory] = useState<Category>('日常会話');
  const [mode, setMode] = useState<ChatMode>('normal');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [currentTeacher, setCurrentTeacher] = useState<AITeacher | null>(null);
  const [allTeachers, setAllTeachers] = useState<AITeacher[]>([]);
  const [showTeacherSelector, setShowTeacherSelector] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasStartedChat, setHasStartedChat] = useState(false);
  const [unsubscribeRef, setUnsubscribeRef] = useState<(() => void) | null>(null);
  const [responseLength, setResponseLength] = useState<'auto' | 'short' | 'medium' | 'long'>('auto');

  // 画面初期化のみ（セッション作成なし）
  const initializePage = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Gemini AIサービスを初期化
      await aiChatService.initializeService();
      console.log('Gemini AIサービスが初期化されました');
      
      // ユーザーとFirebase生徒データを同期
      await firebaseChatService.syncUserWithFirebase();
      
      // Firebaseから先生情報を取得
      const teachers = await firebaseAITeacherService.getAllTeachers();
      setAllTeachers(teachers);
      
      // 最初の先生をデフォルトとして設定（または前回選択した先生）
      const lastSelectedTeacherId = localStorage.getItem('lastSelectedTeacher');
      const defaultTeacher = lastSelectedTeacherId 
        ? teachers.find(t => t.id === lastSelectedTeacherId) || teachers[0]
        : teachers[0];
      setCurrentTeacher(defaultTeacher);
      
      // AI挨拶をローカル表示用にセット（Firebaseには保存しない）
      if (defaultTeacher) {
        // Firebaseの先生データから挨拶を取得（先生固有の挨拶を優先）
        const greetingText = defaultTeacher.greeting || 'こんにちは！どんなことでも気軽に相談してくださいね。';
        setMessages([{
          id: 'greeting-' + Date.now(),
          text: greetingText,
          sender: 'ai',
          timestamp: new Date().toISOString(),
          category: category,
          mode: mode
        }]);
      }
      
    } catch (error) {
      console.error('ページ初期化エラー:', error);
    } finally {
      setIsLoading(false);
    }
  }, [category, mode]);

  // 実際のチャットセッション作成（最初のメッセージ送信時）
  const createChatSession = useCallback(async () => {
    try {
      const sessionId = await firebaseChatService.createChatSession(
        category,
        mode,
        isAnonymous
      );
      setCurrentSessionId(sessionId);
      setHasStartedChat(true);
      
      // 挨拶メッセージをFirebaseに保存（現在の先生の挨拶を使用）
      const greetingText = currentTeacher?.greeting || 'こんにちは！どんなことでも気軽に相談してくださいね。';
      await firebaseChatService.sendMessage(sessionId, greetingText, 'ai', category, mode);
      
      // リアルタイムメッセージ購読を開始
      const unsubscribe = firebaseChatService.subscribeToMessages(sessionId, (messages) => {
        setMessages(messages);
      });
      
      return { sessionId, unsubscribe };
    } catch (error) {
      console.error('セッション作成エラー:', error);
      throw error;
    }
  }, [category, mode, isAnonymous]);

  useEffect(() => {
    // 画面初期化のみ実行（セッション作成なし）
    initializePage();
  }, [initializePage]);

  // コンポーネントアンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      if (unsubscribeRef) {
        unsubscribeRef();
      }
    };
  }, [unsubscribeRef]);

  const handleTeacherChange = () => {
    // 既存のリアルタイム購読をクリーンアップ
    if (unsubscribeRef) {
      unsubscribeRef();
      setUnsubscribeRef(null);
    }
    
    // 先生が変更された時にページを再初期化（セッションは作成しない）
    setHasStartedChat(false);
    setCurrentSessionId('');
    setMessages([]);
    initializePage();
  };
  
  const handleSelectTeacher = (teacher: AITeacher) => {
    // 既存のリアルタイム購読をクリーンアップ
    if (unsubscribeRef) {
      unsubscribeRef();
      setUnsubscribeRef(null);
    }
    
    setCurrentTeacher(teacher);
    localStorage.setItem('lastSelectedTeacher', teacher.id);
    setShowTeacherSelector(false);
    // ページを再初期化（セッションは作成しない）
    setHasStartedChat(false);
    setCurrentSessionId('');
    setMessages([]);
    initializePage();
  };

  const handleSendMessage = async (text: string): Promise<void> => {
    try {
      setIsLoading(true);
      
      let sessionId = currentSessionId;
      let unsubscribe: (() => void) | undefined;
      
      // 最初のメッセージ送信時にセッションを作成
      if (!hasStartedChat) {
        console.log('初回メッセージ送信 - セッションを作成します');
        const sessionData = await createChatSession();
        sessionId = sessionData.sessionId;
        unsubscribe = sessionData.unsubscribe;
      }
      
      if (!sessionId) {
        throw new Error('セッションの作成に失敗しました');
      }
      
      // ユーザーメッセージをFirebaseに送信
      await firebaseChatService.sendMessage(sessionId, text, 'user', category, mode);
      
      // AI応答を生成してFirebaseに送信（応答長制御付き）
      const aiResponse = await firebaseChatService.generateAIResponse(
        text, 
        category, 
        mode, 
        responseLength,
        sessionId,
        true // キャッシュを使用
      );
      await firebaseChatService.sendMessage(sessionId, aiResponse, 'ai', category, mode);
      
      // セッション作成時にunsubscribeが作成された場合、保存する
      if (unsubscribe) {
        setUnsubscribeRef(unsubscribe);
        console.log('リアルタイム購読を開始しました');
      }
      
    } catch (error) {
      console.error('メッセージ送信エラー:', error);
      throw error; // エラーを上位に伝播
    } finally {
      setIsLoading(false);
    }
  };

  // ローディング表示用のコンポーネント
  if (isLoading && messages.length === 0) {
    return (
      <div className="h-screen flex flex-col bg-gray-50">
        <ChatHeader onTeacherChange={handleTeacherChange} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">チャットを初期化中...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <ChatHeader
        currentTeacher={currentTeacher}
        allTeachers={allTeachers}
        showTeacherSelector={showTeacherSelector}
        onTeacherChange={handleTeacherChange}
        onToggleTeacherSelector={() => setShowTeacherSelector(!showTeacherSelector)}
        onSelectTeacher={handleSelectTeacher}
      />
      <ChatMessages messages={messages} currentTeacher={currentTeacher} />
      <ChatInput 
        onSendMessage={handleSendMessage}
        category={category}
        setCategory={setCategory}
        mode={mode}
        setMode={setMode}
        isAnonymous={isAnonymous}
        setIsAnonymous={setIsAnonymous}
        responseLength={responseLength}
        setResponseLength={setResponseLength}
      />
    </div>
  );
};

export default ChatPage;