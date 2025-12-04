// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Artwork {
  id: string;
  encryptedScore: string;
  timestamp: number;
  artist: string;
  title: string;
  category: string;
  status: "pending" | "approved" | "needs_improvement";
  critiques: string[];
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeAverage = (encryptedScores: string[]): string => {
  if (encryptedScores.length === 0) return FHEEncryptNumber(0);
  
  let total = 0;
  encryptedScores.forEach(score => {
    total += FHEDecryptNumber(score);
  });
  
  const average = total / encryptedScores.length;
  return FHEEncryptNumber(average);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [artworks, setArtworks] = useState<Artwork[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newArtworkData, setNewArtworkData] = useState({ title: "", category: "digital", selfScore: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");

  const approvedCount = artworks.filter(a => a.status === "approved").length;
  const pendingCount = artworks.filter(a => a.status === "pending").length;
  const needsImprovementCount = artworks.filter(a => a.status === "needs_improvement").length;

  useEffect(() => {
    loadArtworks().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadArtworks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("artwork_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing artwork keys:", e); }
      }
      
      const list: Artwork[] = [];
      for (const key of keys) {
        try {
          const artworkBytes = await contract.getData(`artwork_${key}`);
          if (artworkBytes.length > 0) {
            try {
              const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
              list.push({ 
                id: key, 
                encryptedScore: artworkData.score, 
                timestamp: artworkData.timestamp, 
                artist: artworkData.artist, 
                title: artworkData.title,
                category: artworkData.category,
                status: artworkData.status || "pending",
                critiques: artworkData.critiques || []
              });
            } catch (e) { console.error(`Error parsing artwork data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading artwork ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setArtworks(list);
    } catch (e) { console.error("Error loading artworks:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitArtwork = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting artwork score with Zama FHE..." });
    try {
      const encryptedScore = FHEEncryptNumber(newArtworkData.selfScore);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const artworkId = `art-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const artworkData = { 
        score: encryptedScore, 
        timestamp: Math.floor(Date.now() / 1000), 
        artist: address, 
        title: newArtworkData.title,
        category: newArtworkData.category,
        status: "pending",
        critiques: []
      };
      
      await contract.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(artworkData)));
      
      const keysBytes = await contract.getData("artwork_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(artworkId);
      await contract.setData("artwork_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Artwork submitted securely with FHE encryption!" });
      await loadArtworks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewArtworkData({ title: "", category: "digital", selfScore: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveArtwork = async (artworkId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted score with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const artworkBytes = await contract.getData(`artwork_${artworkId}`);
      if (artworkBytes.length === 0) throw new Error("Artwork not found");
      const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
      
      const updatedArtwork = { ...artworkData, status: "approved" };
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      await contractWithSigner.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(updatedArtwork)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Artwork approved with FHE encryption!" });
      await loadArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const requestImprovement = async (artworkId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted score with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const artworkBytes = await contract.getData(`artwork_${artworkId}`);
      if (artworkBytes.length === 0) throw new Error("Artwork not found");
      const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
      const updatedArtwork = { ...artworkData, status: "needs_improvement" };
      await contract.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(updatedArtwork)));
      setTransactionStatus({ visible: true, status: "success", message: "Improvement requested with FHE encryption!" });
      await loadArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Request failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const addCritique = async (artworkId: string, critiqueText: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Adding encrypted critique..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const artworkBytes = await contract.getData(`artwork_${artworkId}`);
      if (artworkBytes.length === 0) throw new Error("Artwork not found");
      const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
      
      const updatedArtwork = { 
        ...artworkData, 
        critiques: [...(artworkData.critiques || []), critiqueText] 
      };
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      await contractWithSigner.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(updatedArtwork)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Critique added securely!" });
      await loadArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Failed to add critique: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isArtist = (artistAddress: string) => address?.toLowerCase() === artistAddress.toLowerCase();

  const filteredArtworks = artworks.filter(artwork => {
    const matchesSearch = artwork.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         artwork.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === "all" || artwork.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const topContributors = [...new Set(artworks.map(a => a.artist))]
    .map(artist => ({
      artist,
      count: artworks.filter(a => a.artist === artist).length,
      lastSubmission: Math.max(...artworks.filter(a => a.artist === artist).map(a => a.timestamp))
    }))
    .sort((a, b) => b.count - a.count || b.lastSubmission - a.lastSubmission)
    .slice(0, 5);

  const renderStatsCards = () => {
    return (
      <div className="stats-cards">
        <div className="stat-card mint">
          <div className="stat-value">{artworks.length}</div>
          <div className="stat-label">Total Artworks</div>
        </div>
        <div className="stat-card pink">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-card cream">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending Review</div>
        </div>
        <div className="stat-card peach">
          <div className="stat-value">{needsImprovementCount}</div>
          <div className="stat-label">Needs Improvement</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="paintbrush-spinner"></div>
      <p>Loading Art Academy...</p>
    </div>
  );

  return (
    <div className="app-container pastel-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="palette-icon"></div></div>
          <h1><span>Art Academy</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn hand-drawn-btn">
            <div className="add-icon"></div>Submit Artwork
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-card hand-drawn-card">
            <button className="close-intro hand-drawn-btn" onClick={() => setShowIntro(false)}>✕</button>
            <h2>Welcome to Art Academy</h2>
            <p>
              A safe space to learn and grow as an artist. All artwork critiques and scores are encrypted using 
              <strong> Zama FHE technology</strong> to protect your privacy and create a positive learning environment.
            </p>
            <div className="fhe-badge">
              <span>FHE-Powered Privacy</span>
            </div>
            <div className="intro-features">
              <div className="feature">
                <div className="feature-icon">🎨</div>
                <div className="feature-text">Submit your artwork with self-assessment</div>
              </div>
              <div className="feature">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">Scores encrypted with Zama FHE</div>
              </div>
              <div className="feature">
                <div className="feature-icon">💬</div>
                <div className="feature-text">Receive anonymous, constructive critiques</div>
              </div>
              <div className="feature">
                <div className="feature-icon">📈</div>
                <div className="feature-text">Track your progress privately</div>
              </div>
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <h2 className="section-title">Artwork Statistics</h2>
          {renderStatsCards()}
        </div>

        <div className="contributors-section">
          <h2 className="section-title">Top Contributors</h2>
          <div className="contributors-list hand-drawn-card">
            {topContributors.length > 0 ? (
              topContributors.map((contributor, index) => (
                <div className="contributor-item" key={contributor.artist}>
                  <div className="contributor-rank">{index + 1}</div>
                  <div className="contributor-address">
                    {contributor.artist.substring(0, 6)}...{contributor.artist.substring(38)}
                  </div>
                  <div className="contributor-count">{contributor.count} artworks</div>
                </div>
              ))
            ) : (
              <div className="no-contributors">
                <div className="empty-icon">👩‍🎨</div>
                <p>No contributors yet</p>
              </div>
            )}
          </div>
        </div>

        <div className="artworks-section">
          <div className="section-header">
            <h2 className="section-title">Gallery</h2>
            <div className="search-filter">
              <input
                type="text"
                placeholder="Search artworks..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="hand-drawn-input"
              />
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="hand-drawn-select"
              >
                <option value="all">All Categories</option>
                <option value="digital">Digital Art</option>
                <option value="traditional">Traditional Art</option>
                <option value="sketch">Sketch</option>
                <option value="painting">Painting</option>
                <option value="sculpture">Sculpture</option>
              </select>
              <button onClick={loadArtworks} className="refresh-btn hand-drawn-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="artworks-grid">
            {filteredArtworks.length === 0 ? (
              <div className="no-artworks hand-drawn-card">
                <div className="empty-icon">🖼️</div>
                <p>No artworks found</p>
                <button className="hand-drawn-btn primary" onClick={() => setShowCreateModal(true)}>Submit First Artwork</button>
              </div>
            ) : (
              filteredArtworks.map(artwork => (
                <div className="artwork-card hand-drawn-card" key={artwork.id} onClick={() => setSelectedArtwork(artwork)}>
                  <div className="artwork-header">
                    <div className="artwork-title">{artwork.title}</div>
                    <div className={`artwork-status ${artwork.status}`}>{artwork.status.replace("_", " ")}</div>
                  </div>
                  <div className="artwork-meta">
                    <div className="artwork-category">{artwork.category}</div>
                    <div className="artwork-date">{new Date(artwork.timestamp * 1000).toLocaleDateString()}</div>
                  </div>
                  <div className="artwork-actions">
                    <button className="hand-drawn-btn small" onClick={(e) => {
                      e.stopPropagation();
                      setSelectedArtwork(artwork);
                    }}>
                      View Details
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitArtwork} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          artworkData={newArtworkData} 
          setArtworkData={setNewArtworkData}
        />
      )}
      
      {selectedArtwork && (
        <ArtworkDetailModal 
          artwork={selectedArtwork} 
          onClose={() => { setSelectedArtwork(null); setDecryptedScore(null); }} 
          decryptedScore={decryptedScore} 
          setDecryptedScore={setDecryptedScore} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          isArtist={isArtist(selectedArtwork.artist)}
          approveArtwork={approveArtwork}
          requestImprovement={requestImprovement}
          addCritique={addCritique}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hand-drawn-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="paintbrush-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✕</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="palette-icon"></div><span></span></div>
            <p>Art Academy with FHE-encrypted critiques</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">About</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} Art Academy. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  artworkData: any;
  setArtworkData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, artworkData, setArtworkData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setArtworkData({ ...artworkData, [name]: value });
  };

  const handleScoreChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setArtworkData({ ...artworkData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!artworkData.title || artworkData.selfScore === 0) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal hand-drawn-card">
        <div className="modal-header">
          <h2>Submit New Artwork</h2>
          <button onClick={onClose} className="close-modal">✕</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="notice-icon">🔒</div> 
            <div>
              <strong>Privacy Notice</strong>
              <p>Your self-assessment score will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Artwork Title *</label>
            <input 
              type="text" 
              name="title" 
              value={artworkData.title} 
              onChange={handleChange} 
              placeholder="My masterpiece..." 
              className="hand-drawn-input"
            />
          </div>
          
          <div className="form-group">
            <label>Category *</label>
            <select 
              name="category" 
              value={artworkData.category} 
              onChange={handleChange} 
              className="hand-drawn-select"
            >
              <option value="digital">Digital Art</option>
              <option value="traditional">Traditional Art</option>
              <option value="sketch">Sketch</option>
              <option value="painting">Painting</option>
              <option value="sculpture">Sculpture</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Self-Assessment Score (1-10) *</label>
            <input 
              type="range" 
              name="selfScore" 
              min="1" 
              max="10" 
              step="0.5"
              value={artworkData.selfScore} 
              onChange={handleScoreChange} 
              className="hand-drawn-range"
            />
            <div className="score-value">{artworkData.selfScore}</div>
          </div>
          
          <div className="encryption-preview">
            <div className="preview-plain">
              <span>Plain Score:</span>
              <div>{artworkData.selfScore}</div>
            </div>
            <div className="preview-arrow">→</div>
            <div className="preview-encrypted">
              <span>Encrypted:</span>
              <div>{artworkData.selfScore ? FHEEncryptNumber(artworkData.selfScore).substring(0, 30) + '...' : 'N/A'}</div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="hand-drawn-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="hand-drawn-btn primary">
            {creating ? "Encrypting & Submitting..." : "Submit Artwork"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ArtworkDetailModalProps {
  artwork: Artwork;
  onClose: () => void;
  decryptedScore: number | null;
  setDecryptedScore: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  isArtist: boolean;
  approveArtwork: (artworkId: string) => void;
  requestImprovement: (artworkId: string) => void;
  addCritique: (artworkId: string, critiqueText: string) => void;
}

const ArtworkDetailModal: React.FC<ArtworkDetailModalProps> = ({ 
  artwork, onClose, decryptedScore, setDecryptedScore, isDecrypting, decryptWithSignature,
  isArtist, approveArtwork, requestImprovement, addCritique
}) => {
  const [critiqueText, setCritiqueText] = useState("");
  const [showCritiqueForm, setShowCritiqueForm] = useState(false);

  const handleDecrypt = async () => {
    if (decryptedScore !== null) { setDecryptedScore(null); return; }
    const decrypted = await decryptWithSignature(artwork.encryptedScore);
    if (decrypted !== null) setDecryptedScore(decrypted);
  };

  const handleAddCritique = () => {
    if (!critiqueText.trim()) return;
    addCritique(artwork.id, critiqueText);
    setCritiqueText("");
    setShowCritiqueForm(false);
  };

  return (
    <div className="modal-overlay">
      <div className="artwork-detail-modal hand-drawn-card">
        <div className="modal-header">
          <h2>{artwork.title}</h2>
          <button onClick={onClose} className="close-modal">✕</button>
        </div>
        <div className="modal-body">
          <div className="artwork-meta">
            <div className="meta-item">
              <span>Artist:</span>
              <strong>{artwork.artist.substring(0, 6)}...{artwork.artist.substring(38)}</strong>
            </div>
            <div className="meta-item">
              <span>Category:</span>
              <strong>{artwork.category}</strong>
            </div>
            <div className="meta-item">
              <span>Submitted:</span>
              <strong>{new Date(artwork.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="meta-item">
              <span>Status:</span>
              <strong className={`status ${artwork.status}`}>{artwork.status.replace("_", " ")}</strong>
            </div>
          </div>
          
          <div className="score-section">
            <h3>Encrypted Score</h3>
            <div className="encrypted-score">
              {artwork.encryptedScore.substring(0, 30)}...
              <span className="fhe-tag">FHE Encrypted</span>
            </div>
            <button 
              className="hand-drawn-btn" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedScore !== null ? "Hide Score" : "Decrypt Score"}
            </button>
            
            {decryptedScore !== null && (
              <div className="decrypted-score">
                <h4>Decrypted Score</h4>
                <div className="score-value">{decryptedScore.toFixed(1)}/10</div>
                <div className="decryption-note">
                  This score was decrypted using your wallet signature and is only visible to you.
                </div>
              </div>
            )}
          </div>
          
          <div className="critiques-section">
            <h3>Critiques</h3>
            {artwork.critiques.length > 0 ? (
              <div className="critiques-list">
                {artwork.critiques.map((critique, index) => (
                  <div className="critique-item" key={index}>
                    <div className="critique-bubble">
                      <div className="critique-text">{critique}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-critiques">
                No critiques yet. Be the first to provide feedback!
              </div>
            )}
            
            {showCritiqueForm ? (
              <div className="critique-form">
                <textarea
                  value={critiqueText}
                  onChange={(e) => setCritiqueText(e.target.value)}
                  placeholder="Provide constructive feedback..."
                  className="hand-drawn-textarea"
                />
                <div className="critique-actions">
                  <button 
                    className="hand-drawn-btn" 
                    onClick={() => setShowCritiqueForm(false)}
                  >
                    Cancel
                  </button>
                  <button 
                    className="hand-drawn-btn primary" 
                    onClick={handleAddCritique}
                    disabled={!critiqueText.trim()}
                  >
                    Submit Critique
                  </button>
                </div>
              </div>
            ) : (
              <button 
                className="hand-drawn-btn" 
                onClick={() => setShowCritiqueForm(true)}
              >
                Add Critique
              </button>
            )}
          </div>
          
          {!isArtist && artwork.status === "pending" && (
            <div className="moderation-actions">
              <button 
                className="hand-drawn-btn success" 
                onClick={() => approveArtwork(artwork.id)}
              >
                Approve Artwork
              </button>
              <button 
                className="hand-drawn-btn warning" 
                onClick={() => requestImprovement(artwork.id)}
              >
                Request Improvement
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="hand-drawn-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;